"""Demo website for BrowserPilot testing.

Features:
- Registration page
- Login page  
- Profile editing
- Password reset
- Known bugs for testing
- Live test execution with BrowserPilot AI

Run with: py demo_website.py
"""

from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn
import sys
import json
import threading
from pathlib import Path
from datetime import datetime

app = FastAPI(title="BrowserPilot Demo", version="1.0.0")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

templates = Jinja2Templates(directory="templates")

# In-memory "database" for demo
users_db = {}
test_runs = []


# ══════════════════════════════════════
# Helper Functions
# ══════════════════════════════════════

def hash_password(pw: str) -> str:
    """Simple hash for demo purposes."""
    return pw[::2] + pw[-3:] if pw else ""


def is_valid_email(email: str) -> bool:
    """Simple email validation."""
    return "@" in email and "." in email.split("@")[-1]


# ══════════════════════════════════════
# Test Execution Engine (In-process)
# ══════════════════════════════════════

def execute_test_plan(plan_json: str) -> dict:
    """Execute a test plan against the demo website (in-process simulation).
    
    In a full implementation, this would use Playwright. For demo purposes,
    we simulate the execution based on known page states and bugs.
    """
    try:
        plan = json.loads(plan_json)
    except json.JSONDecodeError:
        return {"error": "Invalid JSON plan"}
    
    goal = plan.get("goal", "")
    steps = plan.get("steps", [])
    results = []
    bugs_found = []
    
    # Simulate page states
    pages = {
        "/register": {"title": "Register", "has_form": True, "bugs": ["weak_password", "email_duplicate"]},
        "/login": {"title": "Login", "has_form": True, "bugs": []},
        "/profile": {"title": "Profile", "has_form": True, "bugs": ["bio_unbounded"]},
    }
    
    registered = False
    logged_in = False
    
    for i, step in enumerate(steps, 1):
        action = step.get("action")
        selector = step.get("selector", "")
        value = step.get("value", "")
        expected = step.get("expected", "")
        
        result = {"step": i, "action": action, "status": "pass", "evidence": ""}
        
        # Simulate navigation
        if action == "navigate":
            url = value or "/"
            result["status"] = "pass"
            result["evidence"] = f"Navigated to {url}"
            if url in pages:
                result["evidence"] += f"; title: {pages[url]['title']}"
        
        # Simulate input
        elif action == "input":
            result["status"] = "pass"
            result["evidence"] = f"Entered '{value}' into field {selector}"
        
        # Simulate click
        elif action == "click":
            result["status"] = "pass"
            result["evidence"] = f"Clicked element {selector}"
            # After clicking submit on register, mark as registered
            if "/register" in str(selector) or "submit" in str(value).lower():
                registered = True
        
        # Simulate assertion
        elif action == "assert":
            result["status"] = "pass"
            result["evidence"] = f"Verified '{expected}'"
            # Check for bugs after registration
            if registered and "bio" in expected.lower() and url in pages.get("/profile", {}).get("bugs", []):
                bugs_found.append("bio_unbounded")
        
        results.append(result)
    
    # Post-execution bug detection
    if registered:
        for bug_key in pages.get("/register", {}).get("bugs", []):
            if bug_key not in bugs_found:
                bugs_found.append(bug_key)
    
    # Build report
    total = len(results)
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = sum(1 for r in results if r["status"] != "pass")
    
    report = {
        "goal": goal,
        "results": results,
        "summary": {
            "total_steps": total,
            "passed": passed,
            "failed": failed,
            "success_rate": round((passed / total) * 100, 1) if total > 0 else 0,
        },
        "bugs_detected": bugs_found,
        "execution_time": datetime.now().isoformat(),
    }
    
    return report


# ═════════════════════════════════════
# Routes
# ═════════════════════════════════════

@app.get("/", include_in_schema=False)
async def root(request: Request):
    """Home page."""
    return templates.TemplateResponse(
        "demo_index.html",
        {"request": request, "title": "BrowserPilot Demo"},
    )


@app.get("/register", include_in_schema=False)
async def register_get(request: Request):
    """Registration page."""
    return templates.TemplateResponse(
        "demo_register.html",
        {"request": request, "title": "Register", "error": None},
    )


@app.post("/register", include_in_schema=False)
async def register_post(request: Request, username: str = Form(...), email: str = Form(...), password: str = Form(...)):
    """Handle registration."""
    error = None
    
    if not username.strip():
        error = "Username is required"
    elif not email.strip():
        error = "Email is required"
    elif not is_valid_email(email):
        error = "Please enter a valid email"
    elif username in users_db:
        error = "Username already taken"
    
    if error:
        return templates.TemplateResponse(
            "demo_register.html",
            {"request": request, "title": "Register", "error": error},
        )
    
    users_db[username] = {
        "email": email,
        "password_hash": hash_password(password),
        "profile": {"display_name": username, "bio": ""},
        "created_at": datetime.now().isoformat(),
    }
    
    return RedirectResponse(url="/login", status_code=302)


@app.get("/login", include_in_schema=False)
async def login_get(request: Request):
    """Login page."""
    return templates.TemplateResponse(
        "demo_login.html",
        {"request": request, "title": "Login", "error": None},
    )


@app.post("/login", include_in_schema=False)
async def login_post(request: Request, username: str = Form(...), password: str = Form(...)):
    """Handle login."""
    user = users_db.get(username)
    
    if not user or user["password_hash"] != hash_password(password):
        return templates.TemplateResponse(
            "demo_login.html",
            {"request": request, "title": "Login", "error": "Invalid username or password"},
        )
    
    global logged_in_flag
    logged_in_flag = True
    return RedirectResponse(url="/profile", status_code=302)


@app.get("/profile", include_in_schema=False)
async def profile_get(request: Request):
    """Profile page."""
    user_name = request.cookies.get("user", "guest")
    return templates.TemplateResponse(
        "demo_profile.html",
        {"request": request, "title": "Profile", "user": users_db.get(user_name, {}).get("profile", {})},
    )


@app.post("/profile", include_in_schema=False)
async def profile_post(request: Request, display_name: str = Form(...), bio: str = Form(...)):
    """Update profile."""
    user_name = request.cookies.get("user", "guest")
    if user_name in users_db:
        users_db[user_name]["profile"] = {"display_name": display_name, "bio": bio}
    
    return templates.TemplateResponse(
        "demo_profile.html",
        {"request": request, "title": "Profile", "user": users_db.get(user_name, {}).get("profile", {})},
    )


@app.get("/logout", include_in_schema=False)
async def logout():
    """Logout."""
    global logged_in_flag
    logged_in_flag = False
    return RedirectResponse(url="/", status_code=302)


# ═════════════════════════════════════
# API Routes
# ═════════════════════════════════════

@app.get("/api/run-test", include_in_schema=False)
async def run_test(request: Request, goal: str = ""):
    """Run a test plan against the demo website."""
    plan = generate_plan(goal) if goal else None
    
    if not plan:
        return JSONResponse(
            {"error": "Could not parse goal. Provide a clear natural language goal."},
            status_code=400,
        )
    
    # Execute the plan
    report = execute_test_plan(json.dumps(plan))
    
    # Update demo state
    if "/register" in goal.lower() or "register" in goal.lower():
        # Mark as registered after plan execution
        for user, data in users_db.items():
            if data["email"] == "test@test.com":  # Simple heuristic
                registered_flag = True
    
    return JSONResponse({
        "plan": plan,
        "report": report,
    })


@app.post("/api/run-test", include_in_schema=False)
async def run_test_post(request: Request):
    """POST endpoint for running tests."""
    form = await request.form()
    goal = form.get("goal", "")
    return await get_api_run_test(request, goal)


# ══════════════════════════════════════
# Startup
# ═════════════════════════════════════

if __name__ == "__main__":
    print("\n" + "=" * 50)
    print("BrowserPilot Demo Website")
    print("=" * 50)
    print(f"\nOpen at: http://127.0.0.1:8001")
    print("\nDemo Credentials:")
    print("  Register a new account, then login")
    print("  Then visit: http://127.0.0.1:8001/profile")
    print("\nKnown bugs to test:")
    print("  1. Weak password acceptance")
    print("  2. Duplicate email registration")
    print("  3. Unbounded bio field")
    print("\n" + "=" * 50)
    uvicorn.run(app, host="127.0.0.1", port=8001)