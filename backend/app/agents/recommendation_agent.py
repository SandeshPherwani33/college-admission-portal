from __future__ import annotations

from typing import Any

from app.eligibility.matcher import match_programs


class RecommendationAgent:
    def match(
        self,
        profile: dict[str, Any],
        criteria_records: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return match_programs(profile, criteria_records)
