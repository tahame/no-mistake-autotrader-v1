from fastapi import APIRouter

router = APIRouter()


@router.get("/", summary="Trade journal (placeholder)")
def journal_list():
    """Placeholder endpoint for trade journal.

    In future versions this will:
    - List historical trades and proposals
    - Provide filters by strategy / symbol
    - Feed analytics and learning
    """
    return {
        "entries": [],
        "note": "Journal/analytics module scaffold – will be implemented with real trade data.",
    }
