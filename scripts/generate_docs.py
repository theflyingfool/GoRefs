#!/usr/bin/env python3
"""
Automated Docstring Documentation Generator for Pokémon GO Reference Knowledge Base (`go_refs`).

Parses Python source files across the codebase using Python's `ast` module, extracts
module docstrings, classes, methods, functions, signatures, type annotations, and Google-style
docstring sections (Args, Returns, Raises), and auto-generates comprehensive HTML and Markdown
documentation files in `docs/`.
"""

import ast
import html
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).parent.parent.resolve()
DOCS_DIR = REPO_ROOT / "docs"


class DocstringParser:
    """Parses Google-style and standard Python docstrings into structured metadata."""

    @staticmethod
    def parse(docstring: str) -> Dict[str, Any]:
        """Parses raw docstring text into summary, description, args, returns, raises, and examples.

        Args:
            docstring: The raw docstring text extracted from an AST node.

        Returns:
            Dict containing parsed fields: summary, description, args, returns, raises, examples.
        """
        if not docstring:
            return {
                "summary": "",
                "description": "",
                "args": [],
                "returns": None,
                "raises": [],
                "examples": []
            }

        lines = docstring.strip().splitlines()
        summary = lines[0].strip() if lines else ""
        
        description_lines = []
        args = []
        returns = None
        raises = []
        examples = []

        current_section = "description"
        current_item = None
        
        i = 1
        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            # Section headers
            if re.match(r"^(Args|Parameters):", stripped, re.IGNORECASE):
                current_section = "args"
                i += 1
                continue
            elif re.match(r"^(Returns|Return):", stripped, re.IGNORECASE):
                current_section = "returns"
                returns_desc = stripped.split(":", 1)[1].strip() if ":" in stripped else ""
                returns = {"type": "", "description": returns_desc}
                i += 1
                continue
            elif re.match(r"^(Raises):", stripped, re.IGNORECASE):
                current_section = "raises"
                i += 1
                continue
            elif re.match(r"^(Example|Examples):", stripped, re.IGNORECASE):
                current_section = "examples"
                i += 1
                continue

            if current_section == "description":
                description_lines.append(line)

            elif current_section == "args":
                # Match param format: "param_name (type): description" or "param_name: description"
                match = re.match(r"^\s*([a-zA-Z0-9_*]+)(?:\s*\(([^)]+)\))?\s*:\s*(.*)$", line)
                if match:
                    param_name, param_type, param_desc = match.groups()
                    current_item = {
                        "name": param_name.strip(),
                        "type": (param_type or "").strip(),
                        "description": param_desc.strip()
                    }
                    args.append(current_item)
                elif current_item and line.startswith("        "):
                    current_item["description"] += " " + stripped

            elif current_section == "returns":
                if returns:
                    if not returns["description"]:
                        # Might be "type: description" on next line
                        match = re.match(r"^\s*(?:([a-zA-Z0-9_\[\], \.]+)\s*:\s*)?(.*)$", line)
                        if match:
                            t, d = match.groups()
                            returns["type"] = (t or "").strip()
                            returns["description"] = (d or "").strip()
                    else:
                        returns["description"] += " " + stripped

            elif current_section == "raises":
                match = re.match(r"^\s*([a-zA-Z0-9_]+)\s*:\s*(.*)$", line)
                if match:
                    exc_type, exc_desc = match.groups()
                    current_item = {"type": exc_type.strip(), "description": exc_desc.strip()}
                    raises.append(current_item)
                elif raises and line.startswith("        "):
                    raises[-1]["description"] += " " + stripped

            elif current_section == "examples":
                examples.append(line)

            i += 1

        description = "\n".join(description_lines).strip()

        return {
            "summary": summary,
            "description": description,
            "args": args,
            "returns": returns,
            "raises": raises,
            "examples": "\n".join(examples).strip() if examples else ""
        }


class ASTCodeInspector:
    """Inspects Python source files using AST to extract metadata on classes, functions, and docstrings."""

    def __init__(self, repo_root: Path):
        self.repo_root = repo_root

    def format_annotation(self, node: Optional[ast.AST]) -> str:
        """Formats AST annotation node into string representation."""
        if node is None:
            return ""
        try:
            return ast.unparse(node)
        except Exception:
            return ""

    def format_arg(self, arg: ast.arg, default: Optional[ast.AST] = None) -> str:
        """Formats a single function argument with annotation and default value."""
        name = arg.arg
        annotation = self.format_annotation(arg.annotation)
        default_str = ast.unparse(default) if default else ""

        res = name
        if annotation:
            res += f": {annotation}"
        if default_str:
            res += f" = {default_str}"
        return res

    def extract_function_info(self, node: ast.AST) -> Dict[str, Any]:
        """Extracts signature, docstring, and parsed details from a function/method AST node."""
        is_async = isinstance(node, ast.AsyncFunctionDef)
        name = node.name
        docstring = ast.get_docstring(node) or ""
        parsed_doc = DocstringParser.parse(docstring)

        decorators = [ast.unparse(d) for d in node.decorator_list]

        # Extract arguments and defaults
        args_node = node.args
        defaults = args_node.defaults
        num_args_without_default = len(args_node.args) - len(defaults)
        
        arg_strings = []
        for idx, arg in enumerate(args_node.args):
            default_node = defaults[idx - num_args_without_default] if idx >= num_args_without_default else None
            arg_strings.append(self.format_arg(arg, default_node))

        if args_node.vararg:
            arg_strings.append(f"*{args_node.vararg.arg}")

        kw_defaults = args_node.kw_defaults
        for idx, arg in enumerate(args_node.kwonlyargs):
            default_node = kw_defaults[idx] if idx < len(kw_defaults) else None
            arg_strings.append(self.format_arg(arg, default_node))

        if args_node.kwarg:
            arg_strings.append(f"**{args_node.kwarg.arg}")

        signature = f"({', '.join(arg_strings)})"
        returns_type = self.format_annotation(node.returns)
        if returns_type:
            signature += f" -> {returns_type}"

        return {
            "name": name,
            "is_async": is_async,
            "decorators": decorators,
            "signature": signature,
            "returns_type": returns_type,
            "docstring": docstring,
            "parsed_doc": parsed_doc
        }

    def inspect_file(self, file_path: Path) -> Optional[Dict[str, Any]]:
        """Inspects a Python file and extracts module docstring, classes, methods, and functions."""
        try:
            code = file_path.read_text(encoding="utf-8")
            tree = ast.parse(code, filename=str(file_path))
        except Exception as e:
            print(f"Warning: Failed to parse {file_path}: {e}")
            return None

        rel_path = file_path.relative_to(self.repo_root).as_posix()
        module_doc = ast.get_docstring(tree) or ""
        parsed_module_doc = DocstringParser.parse(module_doc)

        classes = []
        functions = []

        for stmt in tree.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append(self.extract_function_info(stmt))

            elif isinstance(stmt, ast.ClassDef):
                class_doc = ast.get_docstring(stmt) or ""
                parsed_class_doc = DocstringParser.parse(class_doc)
                bases = [ast.unparse(b) for b in stmt.bases]

                methods = []
                for item in stmt.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        methods.append(self.extract_function_info(item))

                classes.append({
                    "name": stmt.name,
                    "bases": bases,
                    "docstring": class_doc,
                    "parsed_doc": parsed_class_doc,
                    "methods": methods
                })

        return {
            "file_path": rel_path,
            "module_name": rel_path.replace("/", ".").removesuffix(".py"),
            "docstring": module_doc,
            "parsed_doc": parsed_module_doc,
            "classes": classes,
            "functions": functions
        }


class DocumentationGenerator:
    """Generates HTML and Markdown documentation files from extracted AST metadata."""

    def __init__(self, modules_data: List[Dict[str, Any]], output_dir: Path):
        self.modules = sorted(modules_data, key=lambda m: m["file_path"])
        self.output_dir = output_dir

    def generate_all(self) -> Tuple[Path, Path, Path]:
        """Generates docs/index.md, docs/api_reference.md, and docs/api_reference.html."""
        self.output_dir.mkdir(parents=True, exist_ok=True)

        md_index_path = self.output_dir / "index.md"
        md_ref_path = self.output_dir / "api_reference.md"
        html_ref_path = self.output_dir / "api_reference.html"
        html_index_path = self.output_dir / "index.html"

        md_index_content = self._render_markdown_index()
        md_index_path.write_text(md_index_content, encoding="utf-8")

        md_ref_content = self._render_markdown_api_reference()
        md_ref_path.write_text(md_ref_content, encoding="utf-8")

        html_ref_content = self._render_html_api_reference()
        html_ref_path.write_text(html_ref_content, encoding="utf-8")

        # docs/index.html redirects to api_reference.html or acts as landing page
        html_index_content = self._render_html_index_redirect()
        html_index_path.write_text(html_index_content, encoding="utf-8")

        return md_index_path, md_ref_path, html_ref_path

    def _render_markdown_index(self) -> str:
        lines = [
            "# Pokémon GO Reference Knowledge Base - API Index",
            "",
            "> Auto-generated API documentation for `go_refs` Python modules.",
            "",
            "## 📦 Modules Directory",
            "",
            "| Module File | Description | Classes | Functions |",
            "| --- | --- | --- | --- |"
        ]

        for m in self.modules:
            summary = m["parsed_doc"]["summary"] or "No docstring provided."
            cls_count = len(m["classes"])
            fn_count = len(m["functions"])
            link = f"[{m['file_path']}](api_reference.md#{m['file_path'].replace('/', '').replace('.', '').replace('_', '').lower()})"
            lines.append(f"| {link} | {summary} | {cls_count} | {fn_count} |")

        lines.extend([
            "",
            "## 🔗 Quick Links",
            "- [Full Monolithic API Reference (Markdown)](api_reference.md)",
            "- [Interactive HTML API Reference](api_reference.html)",
            "- [Repository Root README](../README.md)",
            ""
        ])
        return "\n".join(lines)

    def _render_markdown_api_reference(self) -> str:
        lines = [
            "# Pokémon GO Reference Knowledge Base (`go_refs`) - Complete API Reference",
            "",
            "Auto-generated code documentation parsed from Python docstrings.",
            ""
        ]

        for m in self.modules:
            lines.append(f"## Module `{m['file_path']}`")
            lines.append("")
            if m["docstring"]:
                lines.append(f"```text\n{m['docstring']}\n```")
                lines.append("")

            if m["classes"]:
                lines.append("### Classes")
                lines.append("")
                for c in m["classes"]:
                    bases_str = f"({', '.join(c['bases'])})" if c["bases"] else ""
                    lines.append(f"#### `class {c['name']}{bases_str}`")
                    if c["parsed_doc"]["summary"]:
                        lines.append(f"*{c['parsed_doc']['summary']}*")
                    lines.append("")
                    if c["docstring"]:
                        lines.append(f"{c['docstring']}\n")

                    if c["methods"]:
                        lines.append("**Methods:**")
                        lines.append("")
                        for mth in c["methods"]:
                            dec_str = " ".join([f"`{d}`" for d in mth["decorators"]]) + " " if mth["decorators"] else ""
                            lines.append(f"- {dec_str}`{mth['name']}{mth['signature']}`")
                            if mth["parsed_doc"]["summary"]:
                                lines.append(f"  - {mth['parsed_doc']['summary']}")
                        lines.append("")

            if m["functions"]:
                lines.append("### Functions")
                lines.append("")
                for fn in m["functions"]:
                    dec_str = " ".join([f"`{d}`" for d in fn["decorators"]]) + " " if fn["decorators"] else ""
                    lines.append(f"#### {dec_str}`def {fn['name']}{fn['signature']}`")
                    lines.append("")
                    if fn["parsed_doc"]["summary"]:
                        lines.append(f"*{fn['parsed_doc']['summary']}*")
                        lines.append("")
                    if fn["docstring"]:
                        lines.append(f"{fn['docstring']}\n")

            lines.append("---")
            lines.append("")

        return "\n".join(lines)

    def _render_html_api_reference(self) -> str:
        sidebar_items = []
        content_sections = []

        for m in self.modules:
            mod_id = m["file_path"].replace("/", "_").replace(".", "_").replace("-", "_")
            
            sub_links = []
            for c in m["classes"]:
                cls_id = f"{mod_id}_{c['name']}"
                sub_links.append(f'<a href="#{cls_id}" class="nav-sub-item">class {c["name"]}</a>')
            for fn in m["functions"]:
                fn_id = f"{mod_id}_{fn['name']}"
                sub_links.append(f'<a href="#{fn_id}" class="nav-sub-item">def {fn["name"]}</a>')

            sub_html = f'<div class="sub-nav">{"".join(sub_links)}</div>' if sub_links else ""
            sidebar_items.append(
                f'<div class="nav-group">'
                f'<a href="#{mod_id}" class="nav-main-item">📄 {m["file_path"]}</a>'
                f'{sub_html}'
                f'</div>'
            )

            # Build Content for Module
            mod_html = []
            mod_html.append(f'<section id="{mod_id}" class="doc-module-card">')
            mod_html.append(f'<div class="module-header">')
            mod_html.append(f'<span class="badge badge-module">MODULE</span>')
            mod_html.append(f'<h2>{html.escape(m["file_path"])}</h2>')
            mod_html.append(f'</div>')

            if m["parsed_doc"]["summary"]:
                mod_html.append(f'<p class="module-summary">{html.escape(m["parsed_doc"]["summary"])}</p>')
            if m["parsed_doc"]["description"]:
                mod_html.append(f'<pre class="docstring-block">{html.escape(m["parsed_doc"]["description"])}</pre>')

            # Render Classes
            if m["classes"]:
                mod_html.append('<h3 class="section-title">Classes</h3>')
                for c in m["classes"]:
                    cls_id = f"{mod_id}_{c['name']}"
                    bases_str = f"({', '.join(c['bases'])})" if c["bases"] else ""
                    mod_html.append(f'<div id="{cls_id}" class="class-card">')
                    mod_html.append(f'<div class="card-header">')
                    mod_html.append(f'<span class="badge badge-class">CLASS</span>')
                    mod_html.append(f'<h3>{html.escape(c["name"])}<span class="bases">{html.escape(bases_str)}</span></h3>')
                    mod_html.append(f'</div>')

                    if c["parsed_doc"]["summary"]:
                        mod_html.append(f'<p class="item-summary">{html.escape(c["parsed_doc"]["summary"])}</p>')
                    if c["parsed_doc"]["description"]:
                        mod_html.append(f'<pre class="docstring-block">{html.escape(c["parsed_doc"]["description"])}</pre>')

                    # Class Args
                    if c["parsed_doc"]["args"]:
                        mod_html.append(self._render_args_table(c["parsed_doc"]["args"]))

                    # Class Methods
                    if c["methods"]:
                        mod_html.append('<div class="methods-container">')
                        mod_html.append('<h4>Methods</h4>')
                        for mth in c["methods"]:
                            mth_id = f"{cls_id}_{mth['name']}"
                            mod_html.append(self._render_function_card(mth, mth_id, is_method=True))
                        mod_html.append('</div>')

                    mod_html.append('</div>')  # End Class Card

            # Render Standalone Functions
            if m["functions"]:
                mod_html.append('<h3 class="section-title">Functions</h3>')
                for fn in m["functions"]:
                    fn_id = f"{mod_id}_{fn['name']}"
                    mod_html.append(self._render_function_card(fn, fn_id, is_method=False))

            mod_html.append('</section>')
            content_sections.append("\n".join(mod_html))

        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pokémon GO Reference Knowledge Base - API Reference</title>
  <style>
    :root {{
      --bg-dark: #0f172a;
      --bg-card: #1e293b;
      --bg-hover: #334155;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-gold: #fbbf24;
      --accent-purple: #c084fc;
      --accent-green: #34d399;
      --border: #334155;
    }}
    * {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    }}
    body {{
      background-color: var(--bg-dark);
      color: var(--text-main);
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }}
    header {{
      background: rgba(30, 41, 59, 0.9);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 1rem 2rem;
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }}
    header h1 {{
      font-size: 1.3rem;
      background: linear-gradient(135deg, var(--accent), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }}
    header nav a {{
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
      margin-left: 1rem;
      padding: 0.4rem 0.8rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      transition: all 0.2s ease;
    }}
    header nav a:hover {{
      background: var(--accent);
      color: #0f172a;
    }}
    .docs-layout {{
      display: flex;
      flex: 1;
      max-width: 1600px;
      margin: 0 auto;
      width: 100%;
    }}
    .sidebar {{
      width: 320px;
      background: #111827;
      border-right: 1px solid var(--border);
      padding: 1.5rem 1rem;
      position: sticky;
      top: 60px;
      height: calc(100vh - 60px);
      overflow-y: auto;
    }}
    .search-box {{
      width: 100%;
      padding: 0.6rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-main);
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }}
    .search-box:focus {{
      outline: 2px solid var(--accent);
    }}
    .nav-group {{
      margin-bottom: 1rem;
    }}
    .nav-main-item {{
      display: block;
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
      padding: 0.4rem 0.6rem;
      border-radius: 0.4rem;
      font-size: 0.95rem;
    }}
    .nav-main-item:hover {{
      background: var(--bg-hover);
    }}
    .sub-nav {{
      margin-left: 1rem;
      border-left: 2px solid var(--border);
      padding-left: 0.5rem;
    }}
    .nav-sub-item {{
      display: block;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.85rem;
      padding: 0.2rem 0.4rem;
      font-family: monospace;
    }}
    .nav-sub-item:hover {{
      color: var(--text-main);
    }}
    .main-content {{
      flex: 1;
      padding: 2rem;
      overflow-y: auto;
    }}
    .doc-module-card {{
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }}
    .module-header {{
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }}
    .module-summary {{
      color: var(--text-muted);
      font-size: 1.05rem;
      margin-bottom: 1rem;
    }}
    .docstring-block {{
      background: #090d16;
      border: 1px solid #1e293b;
      padding: 1rem;
      border-radius: 0.5rem;
      color: #cbd5e1;
      font-family: monospace;
      font-size: 0.9rem;
      white-space: pre-wrap;
      margin-bottom: 1rem;
    }}
    .section-title {{
      font-size: 1.2rem;
      color: var(--accent-gold);
      margin: 1.5rem 0 1rem 0;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.3rem;
    }}
    .class-card, .func-card {{
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 0.6rem;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }}
    .card-header {{
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-bottom: 0.5rem;
      flex-wrap: wrap;
    }}
    .card-header h3, .card-header h4 {{
      font-family: monospace;
      color: var(--text-main);
    }}
    .bases {{
      color: var(--text-muted);
      font-weight: normal;
      font-size: 0.9rem;
    }}
    .badge {{
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.2rem 0.5rem;
      border-radius: 0.3rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }}
    .badge-module {{ background: #0284c7; color: white; }}
    .badge-class {{ background: #8b5cf6; color: white; }}
    .badge-func {{ background: #10b981; color: white; }}
    .badge-method {{ background: #f59e0b; color: white; }}
    .signature {{
      background: #1e293b;
      color: var(--accent);
      padding: 0.6rem 0.8rem;
      border-radius: 0.4rem;
      font-family: monospace;
      font-size: 0.9rem;
      margin: 0.5rem 0 1rem 0;
      overflow-x: auto;
    }}
    .args-table {{
      width: 100%;
      border-collapse: collapse;
      margin: 0.75rem 0;
      font-size: 0.9rem;
    }}
    .args-table th, .args-table td {{
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      text-align: left;
    }}
    .args-table th {{
      background: #1e293b;
      color: var(--accent-gold);
    }}
    .type-tag {{
      color: var(--accent-purple);
      font-family: monospace;
    }}
    .returns-box {{
      background: rgba(52, 211, 153, 0.1);
      border-left: 3px solid var(--accent-green);
      padding: 0.5rem 0.8rem;
      margin-top: 0.5rem;
      font-size: 0.9rem;
      border-radius: 0 0.4rem 0.4rem 0;
    }}
  </style>
</head>
<body>
  <header>
    <h1>Pokémon GO Master Reference - Code API Documentation</h1>
    <nav>
      <a href="/">← Back to Web Explorer</a>
      <a href="index.md">View Markdown (index.md)</a>
    </nav>
  </header>

  <div class="docs-layout">
    <aside class="sidebar">
      <input type="text" id="doc-search" class="search-box" placeholder="Filter modules & symbols..." onkeyup="filterDocs()">
      <div id="sidebar-nav">
        {"".join(sidebar_items)}
      </div>
    </aside>

    <main class="main-content">
      {"".join(content_sections)}
    </main>
  </div>

  <script>
    function filterDocs() {{
      const query = document.getElementById('doc-search').value.toLowerCase();
      const groups = document.querySelectorAll('.nav-group');
      const modules = document.querySelectorAll('.doc-module-card');

      groups.forEach(g => {{
        const text = g.textContent.toLowerCase();
        g.style.display = text.includes(query) ? 'block' : 'none';
      }});

      modules.forEach(m => {{
        const text = m.textContent.toLowerCase();
        m.style.display = text.includes(query) ? 'block' : 'none';
      }});
    }}
  </script>
</body>
</html>
"""
        return html_template

    def _render_args_table(self, args: List[Dict[str, str]]) -> str:
        rows = []
        for a in args:
            type_str = f'<span class="type-tag">{html.escape(a["type"])}</span>' if a["type"] else "-"
            rows.append(
                f'<tr>'
                f'<td><code>{html.escape(a["name"])}</code></td>'
                f'<td>{type_str}</td>'
                f'<td>{html.escape(a["description"])}</td>'
                f'</tr>'
            )

        return f"""
        <table class="args-table">
          <thead>
            <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
          </thead>
          <tbody>
            {"".join(rows)}
          </tbody>
        </table>
        """

    def _render_function_card(self, fn: Dict[str, Any], fn_id: str, is_method: bool = False) -> str:
        badge_class = "badge-method" if is_method else "badge-func"
        badge_text = "METHOD" if is_method else "FUNCTION"

        dec_str = " ".join([f'<span class="type-tag">{html.escape(d)}</span>' for d in fn["decorators"]])
        if dec_str:
            dec_str += " "

        html_out = []
        html_out.append(f'<div id="{fn_id}" class="func-card">')
        html_out.append(f'<div class="card-header">')
        html_out.append(f'<span class="badge {badge_class}">{badge_text}</span>')
        html_out.append(f'<h4>{dec_str}def {html.escape(fn["name"])}</h4>')
        html_out.append(f'</div>')

        html_out.append(f'<div class="signature">def {html.escape(fn["name"])}{html.escape(fn["signature"])}</div>')

        if fn["parsed_doc"]["summary"]:
            html_out.append(f'<p class="item-summary">{html.escape(fn["parsed_doc"]["summary"])}</p>')

        if fn["parsed_doc"]["description"]:
            html_out.append(f'<pre class="docstring-block">{html.escape(fn["parsed_doc"]["description"])}</pre>')

        if fn["parsed_doc"]["args"]:
            html_out.append(self._render_args_table(fn["parsed_doc"]["args"]))

        if fn["parsed_doc"]["returns"]:
            ret = fn["parsed_doc"]["returns"]
            ret_desc = html.escape(ret["description"]) if ret["description"] else "No return description."
            ret_type = f' <code>({html.escape(ret["type"])})</code>' if ret["type"] else ""
            html_out.append(f'<div class="returns-box"><strong>Returns{ret_type}:</strong> {ret_desc}</div>')

        html_out.append('</div>')
        return "\n".join(html_out)

    def _render_html_index_redirect(self) -> str:
        return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=api_reference.html">
  <title>Redirecting to API Reference...</title>
</head>
<body>
  <p>Redirecting to <a href="api_reference.html">API Reference Documentation</a>...</p>
</body>
</html>
"""


def main() -> None:
    """Dispatches docstring extraction and document generation across all project Python files."""
    print("=" * 70)
    print("Starting Automated Docstring Documentation Generator")
    print("=" * 70)

    inspector = ASTCodeInspector(REPO_ROOT)
    
    # Target files to inspect
    target_files = [REPO_ROOT / "go_refs.py"]
    for path in (REPO_ROOT / "src").rglob("*.py"):
        target_files.append(path)
    for path in (REPO_ROOT / "scripts").rglob("*.py"):
        if path.name != "generate_docs.py":
            target_files.append(path)

    modules_data = []
    for fpath in sorted(target_files):
        if fpath.exists():
            mod_data = inspector.inspect_file(fpath)
            if mod_data:
                modules_data.append(mod_data)

    print(f"[DocGen] Discovered and inspected {len(modules_data)} Python modules.")

    generator = DocumentationGenerator(modules_data, DOCS_DIR)
    md_index, md_ref, html_ref = generator.generate_all()

    print(f"  ✓ Auto-generated: {md_index.relative_to(REPO_ROOT)}")
    print(f"  ✓ Auto-generated: {md_ref.relative_to(REPO_ROOT)}")
    print(f"  ✓ Auto-generated: {html_ref.relative_to(REPO_ROOT)}")
    print("[DocGen] Documentation generation finished successfully.\n")


if __name__ == "__main__":
    main()
