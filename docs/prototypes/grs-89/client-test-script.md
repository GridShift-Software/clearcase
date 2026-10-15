# Client test script (GRS-89 navigation study)

A moderated session for one client user, about 40 minutes. It compares Variant A (topic sidebar) and Variant B (task desk) on the same synthetic case. The prototype is in the [README](README.md).

## Before the session

- Start the prototype: `bun run --bun prototype:navigation`. It serves `http://127.0.0.1:44189/prototype/navigation` on loopback only, so share your screen or seat the participant at your machine.
- Reload before each arm. Reloading clears all notes, time and drafts.
- Counterbalance: odd participants do A then B, even participants B then A. Run desktop (1280 wide) first, then the phone tasks at 390 wide (browser device mode, or a phone on the same machine's screen share).
- Do not open Operator study in front of the participant, except where task 7 says so.
- Record: time to first click, wrong destinations, recoveries, the words they look for, and what they say. Do not help until they have been stuck for 60 seconds.

## Say to the participant

"This is a mock-up with an invented case, Kestrel v Marula. Nothing is real and nothing is saved. We are testing the design, not you. Please think aloud. You can stop at any time."

## Tasks

Read each task as written. Don't use the screen's words.

| # | Task (read aloud) | Done when | Watch for |
| --: | --- | --- | --- |
| 1 | "Has anything new been published for this case, and is anything still waiting?" | They name the active Results version and the S-4 submission state | Whether "Planned" confuses them |
| 2 | "Find every document that mentions the gearbox. Open one at the page it is cited, then get back to where you were." | Back at the result list, with the search still there | Escape, ✕ or Back; whether focus and place return |
| 3 | "Event D-0344 in the case history matters. Which issue does it support, and which risk relies on it? Then go back to that event." | They reach Issue B, Risk R-2 and D-0344 again | Path taken; whether the return lands on the event |
| 4 | "Start a note about Issue C. Before you save it, look at something else, then come back and save it." | The note is saved and linked to Issue C | Whether they find the draft again; Save versus Discard |
| 5 | (Phone, 390 wide) "You just spent 30 minutes on a call about this case. Record it." | A time entry is saved | Number of taps; where they look first |
| 6 | "Compare two versions of a document, then prepare a packet for the client that leaves your notes out." | Document Diff reached; packet scope shown with notes excluded, then downloaded | Whether they confuse it with Court Bundle; whether the scope is clear |
| 7 | Moderator opens Operator study and publishes Results v4, then returns to the Matter & Strategy page at Issue C. "A new version has been published. Look at it without losing your place." | They view v4 and are still at Issue C | Whether they notice the banner, the change list and the View button |
| 8 | "Switch to the other design and carry on from where you are." (Use the prototype bar.) | Same page and section in the other arm | Whether the switch disorients them |

Run tasks 1 to 4, 6 and 8 in each arm at desktop width, and task 5 in each arm at phone width. Task 7 runs once, in the second arm.

## After each arm

Ask them to rate each statement from 1 (disagree) to 5 (agree), then ask why:

1. I could find what I needed without guessing.
2. I always knew where I was in the case.
3. Getting back from a document was easy.
4. I could do quick notes and time on a phone.

## At the end

- "If you could keep one of the two, which, and why?"
- "Was anything missing that you use in the current tool?"
- "Did any word or group name confuse you?"

## Recording results

Write one line per task and arm: completed (yes, with help, no), actions, wrong destinations, and a quote. Keep recordings and notes on the case team's own storage, not in Git or an external service. Report ratings as opinions from this session.
