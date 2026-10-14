# Portable conversations

In **New → Terminal**, select the destination agent/account, choose **Continue from any harness**, and select the exact saved conversation. Imports support Claude, Codex and Grok. The picker loads the latest 200 native conversations plus locally imported records. Use **Load older conversations** for earlier history. Search filters the loaded entries. Check the working directory and enter what to continue before launching.

Agent Desk stores an immutable import in its private `data/conversations/` directory. A normalized context file preserves messages and tool calls/results; the original events remain in the import. The destination receives a prompt to read that context and continue the requested work. A subsequent imported session containing that handoff links back to its original history, so repeated switches retain the earlier messages. Imported records remain available if their native files move.

This is conversation handoff into a new native session. It does not transplant provider-private reasoning, native permissions, credentials, open processes, or tool execution state. The source terminal is left running. Avoid asking both sessions to modify the same files simultaneously. Real synthetic CLI conversations have verified Claude → Codex → Claude and Claude → Grok → Claude. Exact facts and parent-history links were checked. These small checks do not establish task-scale equivalence across provider-specific tools.

## Library boundary

`agent_desk.conversations` depends only on the Python standard library and contains no dashboard/runtime imports:

```python
from agent_desk.conversations import read_transcript, context_document, handoff_prompt

record = read_transcript('/path/to/session.jsonl', 'claude')
# record['schema'] == 'portable-conversation/1'
# record['messages']: normalized role/content/timestamp entries
# record['events']: unchanged native source records
# record['source']: harness, native identity and source path
# record['warnings']: state that cannot be resumed across providers
context = context_document(record)
```

`conversation_bridge.py` handles local discovery, private persistence, and source selection. Authenticated POST routes are `/api/conversations/list`, `/api/conversations/import`, and `/api/conversations/prepare`. Import uses the exact opaque source ID returned by discovery. No automatic selection by working directory or latest session is used for a cross-harness handoff.

Tests: `tests/test_annotation_batch.py` and `tests/browser/annotation-batch.cjs`. Browser results use fictional transcripts and mocked launch APIs.
