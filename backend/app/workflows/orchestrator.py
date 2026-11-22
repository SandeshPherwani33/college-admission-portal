from __future__ import annotations

from typing import Any, Dict, List, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agents.allocation_agent import AllocationAgent
from app.agents.document_agent import DocumentAgent
from app.agents.interview_agent import InterviewAgent
from app.agents.profile_agent import ProfileAgent
from app.agents.recommendation_agent import RecommendationAgent
from app.core.config import get_settings
from app.database.store import get_store
from app.llm.provider import get_llm_provider

settings = get_settings()


class StudentWorkflowState(TypedDict):
    student_id: str
    status: str
    profile: Dict[str, Any]
    document: Dict[str, Any]
    recommendations: List[Dict[str, Any]]
    interview: Dict[str, Any]
    allocation: Dict[str, Any]
    warnings: List[str]


class UniApplyOrchestrator:
    def __init__(self) -> None:
        self.llm_provider = get_llm_provider()
        self.profile_agent = ProfileAgent()
        self.document_agent = DocumentAgent()
        self.recommendation_agent = RecommendationAgent()
        self.interview_agent = InterviewAgent()
        self.allocation_agent = AllocationAgent()
        self.mode = self.llm_provider.mode
        self.graph = self._build_graph()

    def _build_graph(self):
        graph = StateGraph(StudentWorkflowState)

        def intake_node(state: StudentWorkflowState) -> Dict[str, Any]:
            profile = self.profile_agent.extract(state.get("profile", {}))
            return {"profile": profile, "status": "intake_complete", "warnings": []}

        def validation_node(state: StudentWorkflowState) -> Dict[str, Any]:
            profile = state["profile"]
            missing = profile.get("missing_fields", [])
            warnings = list(missing) if missing else []
            return {"profile": profile, "warnings": warnings, "status": "validation_complete"}

        def document_node(state: StudentWorkflowState) -> Dict[str, Any]:
            profile = state["profile"]
            document = self.document_agent.normalize(
                filename="student_document.pdf",
                metadata={
                    "institution": profile.get("board") or "Board record",
                    "board": profile.get("board") or "Unknown",
                    "exam": profile.get("stream") or "General",
                    "percentage": profile.get("academic_score"),
                    "year": 2026,
                },
            )
            return {"document": document, "status": "document_normalized", "warnings": document.get("warnings", [])}

        def recommendation_node(state: StudentWorkflowState) -> Dict[str, Any]:
            recommendations = self.recommendation_agent.match(
                state["profile"],
                get_store().get_program_criteria(),
            )
            return {"recommendations": recommendations, "status": "recommendations_ready"}

        def interview_node(state: StudentWorkflowState) -> Dict[str, Any]:
            interview = self.interview_agent.generate(state["student_id"], state["profile"].get("stream", "B.Tech"), 3, "text")
            return {"interview": interview, "status": "interview_ready"}

        def allocation_node(state: StudentWorkflowState) -> Dict[str, Any]:
            allocation = self.allocation_agent.simulate(
                state["student_id"],
                [item["institution"] for item in state["recommendations"]],
                state["profile"].get("budget") or 0,
                state["profile"].get("reservation_category") or "General",
            )
            return {"allocation": allocation, "status": "allocation_complete"}

        def review_node(state: StudentWorkflowState) -> Dict[str, Any]:
            warnings = list(state.get("warnings", []))
            if state.get("document"):
                warnings.extend(state["document"].get("warnings", []))
            return {"warnings": warnings, "status": "review_complete"}

        graph.add_node("intake", intake_node)
        graph.add_node("validation", validation_node)
        graph.add_node("document", document_node)
        graph.add_node("recommendation", recommendation_node)
        graph.add_node("interview", interview_node)
        graph.add_node("allocation", allocation_node)
        graph.add_node("review", review_node)

        graph.add_edge(START, "intake")
        graph.add_edge("intake", "validation")
        graph.add_edge("validation", "document")
        graph.add_edge("document", "recommendation")
        graph.add_edge("recommendation", "interview")
        graph.add_edge("interview", "allocation")
        graph.add_edge("allocation", "review")
        graph.add_edge("review", END)
        return graph.compile()

    def run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        student_id = payload.get("student_id") or "demo-student-1"
        profile = payload.get("profile", payload)
        initial_state: StudentWorkflowState = {
            "student_id": student_id,
            "status": "queued",
            "profile": profile,
            "document": {},
            "recommendations": [],
            "interview": {},
            "allocation": {},
            "warnings": [],
        }
        result = self.graph.invoke(initial_state)
        result["model_mode"] = self.mode
        return result


orchestrator = UniApplyOrchestrator()
