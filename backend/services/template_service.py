"""
Template Service — render message template với placeholders.
Placeholders: {requester_name}, {product_name}, {ticket_id},
              {due_date}, {days_left}, {time_label}
"""
from __future__ import annotations

SAMPLE_DATA = {
    "requester_name": "John Doe",
    "product_name": "GameA",
    "ticket_id": "9999",
    "due_date": "15/04/2026",
    "days_left": "3",
    "time_label": "will expire on 15/04/2026",
    "tagged_handler": "Jane Smith",
}


def render(content: str, data: dict) -> str:
    """Replace {placeholder} với giá trị từ data."""
    result = content
    for key, value in data.items():
        result = result.replace(f"{{{key}}}", str(value) if value is not None else "")
    return result


def preview(content: str) -> str:
    """Render với sample data để xem trước template."""
    return render(content, SAMPLE_DATA)
