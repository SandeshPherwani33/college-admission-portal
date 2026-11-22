from __future__ import annotations

from typing import Dict, List


class AllocationAgent:
    def simulate(self, candidate: str, preferences: List[str], budget: float, category: str) -> Dict[str, object]:
        reason = (
            "No allocation was made: this workflow does not provide an explicit ordered program list "
            "and configured seat capacities."
        )
        return {
            "candidate": candidate,
            "allocated_college": None,
            "allocated_course": None,
            "round_number": 1,
            "waitlist_status": "unallocated",
            "reasons": [reason],
            "explanation": [reason],
            "unallocated_reason": reason,
            "seats_remaining": {},
            "notes": ["Workflow allocation placeholder only; not an official admission offer."],
        }
