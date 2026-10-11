---
name: user-choice
description: Present anything the user must choose or approve — review findings, a commit message, a design option, any decision — as main text right above the options. Use every time you ask the user to pick, approve, or confirm.
---

# User choice

The user must be able to read what they are deciding on in the main text,
right above the options.

## How to ask

The content is the full thing being decided: the complete commit message,
every finding with its problem, repro, and suggested fix, or each option's
trade-offs.

Pick the form by whether the turn has already made a tool call:

- **No tool call yet this turn:** write the content as main text, then
  call the choice prompt (`ask_user` in Copilot CLI). Keep the prompt's
  message to a short question and its options to short labels, with the
  recommended one as the default.
- **Any tool call earlier this turn:** while a prompt waits, the CLI
  collapses that turn's earlier text, content included. Do not call the
  prompt. End the turn with a final reply holding the content as main
  text, then numbered options the user answers by number.

## Never

- Put the content only inside the prompt form.
- Refer to content from an earlier response ("the message above").
- Call the prompt after a tool call in the same turn.
- Ask the user to approve text they have not been shown in full.

If the user edits the content, show the revised version the same way
before acting on it.
