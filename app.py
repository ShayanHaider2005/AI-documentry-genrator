import markdown
import json
from flask import Flask, render_template, abort, jsonify

app = Flask(__name__)

README_PATH = "README.md"


def read_markdown(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


@app.route("/")
def index():
    md = read_markdown(README_PATH)
    html = markdown.markdown(md, extensions=["extra", "toc"])
    return render_template(
        "index.html", content=html, title="DocuBot Documentation"
    )


@app.route("/api/docs")
def api_docs():
    md = read_markdown(README_PATH)
    html = markdown.markdown(md, extensions=["extra", "toc"])
    plain = markdown.markdown(md, extensions=["plain"])
    return jsonify(
        {
            "title": "DocuBot Documentation",
            "markdown": md,
            "html": html,
        }
    )


@app.route("/about")
def about():
    return render_template("about.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)