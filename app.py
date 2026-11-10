"""BrowserPilot - Professional AI Browser Automation Platform.

A complete, professional web application with multiple pages,
beautiful design, and 100% free (no API keys, no login wall).
"""

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn
import sys
import os
from pathlib import Path

app = FastAPI(
    title="BrowserPilot",
    description="AI Browser Automation & Quality Assurance Platform",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")

# Import and include the test planner module
from planner import generate_plan, execute_plan


# ═══════════════════════════════════════
# Core Routes
# ═══════════════════════════════════════

@app.get("/", include_in_schema=False)
async def landing(request: Request):
    """Landing page with professional design."""
    return templates.TemplateResponse(
        "landing.html",
        {"request": request, "title": "BrowserPilot", "version": "1.0.0"},
    )


@app.get("/app", include_in_schema=False)
async def app_shell(request: Request):
    """Application shell page."""
    return templates.TemplateResponse(
        "app_shell.html",
        {"request": request, "title": "BrowserPilot - App", "version": "1.0.0"},
    )


@app.get("/about", include_in_schema=False)
async def about(request: Request):
    """About page."""
    return templates.TemplateResponse(
        "about.html",
        {"request": request, "title": "About BrowserPilot", "version": "1.0.0"},
    )


@app.get("/features", include_in_schema=False)
async def features(request: Request):
    """Features page."""
    return templates.TemplateResponse(
        "features.html",
        {"request": request, "title": "Features", "version": "1.0.0"},
    )


@app.get("/pricing", include_in_schema=False)
async def pricing(request: Request):
    """Pricing page - always free."""
    return templates.TemplateResponse(
        "pricing.html",
        {"request": request, "title": "Pricing", "version": "1.0.0"},
    )


@app.get("/contact", include_in_schema=False)
async def contact(request: Request):
    """Contact page."""
    return templates.TemplateResponse(
        "contact.html",
        {"request": request, "title": "Contact", "version": "1.0.0"},
    )


# ═══════════════════════════════════════
# API Routes
# ═══════════════════════════════════════

@app.get("/api/health", include_in_schema=False)
async def api_health():
    """Health check API."""
    return JSONResponse({"status": "ok", "version": "1.0.0"})


# ═══════════════════════════════════════
# Startup
# ═══════════════════════════════════════

@app.on_event("startup")
async def startup_event():
    """Initialize on startup."""
    # Ensure data directory exists
    Path("data").mkdir(parents=True, exist_ok=True)

    # Initialize database if needed
    db_path = Path("data/browserpilot.db")
    if not db_path.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)
        db_path.write_text("{}")

    print(f"\n╔════════════════════════════════════════")
    print(f"║  BrowserPilot v1.0.0")
    print(f"║  AI Browser Automation & QA Platform")
    print(f"╚═══════════════════════════════════════")
    print(f"  Open at: http://127.0.0.1:8000")
    print(f"  Docs:    http://127.0.0.1:8000/api/docs\n")


# ═══════════════════════════════════════
# Main
# ═══════════════════════════════════════

if __name__ == "__main__":
    print("\nStarting BrowserPilot...")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")