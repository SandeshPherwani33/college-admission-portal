from typing import Dict, List

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AllocationRequest(BaseModel):
    student_id: str = Field(min_length=1, max_length=100)
    preferences: List[str] = Field(max_length=100)
    budget: float | None = Field(default=None, ge=0)
    category: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def preferences_are_unique(self):
        if len(self.preferences) != len(set(self.preferences)):
            raise ValueError("Program preferences must be unique and ordered.")
        return self


class AllocationBatchStudent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    student_id: str = Field(min_length=1, max_length=100)
    preferences: List[str] = Field(max_length=100)

    @model_validator(mode="after")
    def preferences_are_unique(self):
        if len(self.preferences) != len(set(self.preferences)):
            raise ValueError("Program preferences must be unique and ordered.")
        return self


class AllocationBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cycle_id: str = Field(
        min_length=1,
        max_length=100,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    students: List[AllocationBatchStudent] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def students_are_unique(self):
        student_ids = [item.student_id for item in self.students]
        if len(student_ids) != len(set(student_ids)):
            raise ValueError("A student may appear only once in an allocation run.")
        return self


class AllocationOutcome(BaseModel):
    student_id: str
    candidate: str
    allocated_program_id: str | None
    allocated_college: str | None
    allocated_course: str | None
    preference_rank: int | None
    priority_position: int | None
    round_number: int
    waitlist_status: str
    reasons: List[str] = Field(default_factory=list)
    explanation: List[str] = Field(default_factory=list)
    unallocated_reason: str | None = None
    seats_remaining: Dict[str, int] = Field(default_factory=dict)
    notes: List[str] = Field(default_factory=list)


class AllocationResponse(AllocationOutcome):
    run_id: str
    input_hash: str
    created_at: str
    algorithm_version: str
    cycle_id: str | None = None
    cycle_revision: int | None = None


class AllocationRunResponse(BaseModel):
    run_id: str
    input_hash: str
    created_at: str
    algorithm_version: str
    cycle_id: str | None = None
    cycle_revision: int | None = None
    seats_remaining: Dict[str, int] = Field(default_factory=dict)
    results: List[AllocationOutcome] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)
