"""BrowserPilot - One command to rule them all.

Run:    py run.py
It will:
  1. Verify environment (Python, Chromium, DB)
  2. Start the FastAPI server
  3. Auto-open the browser
"""

import webbrowser
import subprocess
import sys
import os
from pathlib import Path

def check_environment():
    """Verify that required tools are available."""
    issues = []
    
    # Check Python version
    if sys.version_info < (3, 10):
        issues.append("Python >= 3.10 required (found {})".format(sys.version_info))
    
    # Check Chromium/Playwright
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        issues.append("playwright not installed - run: py -3 -m pip install playwright")
    
    # Check if DB directory exists
    db_path = Path("data/browserpilot.db")
    if not db_path.parent.exists():
        issues.append(f"DB directory {db_path.parent} doesn't exist")
    
    return issues

def main():
    issues = check_environment()
    if issues:
        print("Environment check FAILED:")
        for issue in issues:
            print(f"  - {issue}")
        print("\nFix these issues before running.")
        return
    
    # Open browser after a short delay
    def open_browser():
        webbrowser.open("http://127.0.0.1:8000")
    
    # Start the server
    print("Starting BrowserPilot...")
    print("=" * 50)
    print("Opening browser in a moment...")
    print("=" * 50)
    
    # Start uvicorn in background
    subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"],
        cwd=r"D:\AIproject",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    
    # Schedule browser open
    import threading
    import time
    time.sleep(2)  # Wait for server to start
    open_browser()
    
    # Keep the console alive
    print("\nBrowserPilot running at http://127.0.0.1:8000")
    print("Press Ctrl+C to stop")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()