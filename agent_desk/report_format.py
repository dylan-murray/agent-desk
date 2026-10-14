"""Shared instructions for visual Inbox reports."""

STRUCTURE_GUIDANCE = (
    'Write the report as a document, not a wall of prose. The Inbox renders Markdown structure: '
    'one # title, ## sections, ### subsections, - and 1. lists with indented sub-bullets, '
    '| pipe | tables | with an alignment row for anything comparative or numeric, > blockquotes for a single key takeaway, '
    '--- between major parts, **bold** lead-in labels, *italics* for an aside, `inline code` for commands and paths, '
    'and fenced blocks tagged with a language. Open with a bolded one-line summary label, such as **Short version:**, before the detail. '
    'Raw HTML in the body is not rendered; use an html-diagram fence when you need real HTML.'
)

DIAGRAM_GUIDANCE = 'When a visual would clarify a flow, architecture or comparison, include a compact HTML diagram in the final Inbox report using a fenced html-diagram block. Use self-contained HTML/CSS and inline SVG, responsive layout, a descriptive title and a short prose explanation outside the fence. Native details/summary works; JavaScript, external assets and navigation are disabled. Keep each diagram below 200 KB; plain html fences remain source code. Do not add diagrams to simple status updates.'
