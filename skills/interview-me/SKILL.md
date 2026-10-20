---
name: interview-me
description: Find out what the user actually wants before any plan exists, by asking one question at a time, each with a guess attached, until you can predict their answers (about 95% confidence), then get an explicit yes on a short statement of intent. Required before every plan (doing-substantial-work step 2, plan mode, work-council, any "plan this" request). Also use when the user says "interview me", "grill me", "are we sure?" or "stress-test my thinking". Skipped only for mechanical asks (rename, typo, file move), pure questions, or when the user's message already states outcome, user, success, constraint and out of scope.
---

# Interview me

What people ask for and what they want differ. "A dashboard" may mean "a list". "Make it faster" has no number. The cheapest moment to find the gap is before the plan, so this runs first in every planning phase.

## When it runs

- **Always** before a plan is written: `doing-substantial-work` step 2, plan mode, `work-council`, `llm-council` questions about what to build, and any "plan this" request.
- **Skip it** for mechanical work (rename, typo, format, file move), pure information questions, or when the request already answers all six restate lines below. When you skip, say so in one line in the plan ("Intent was fully stated, no interview").
- **Short form** when you are already above about 80%: skip straight to the restate (step 4) and ask for a yes.
- **Never** in non-interactive runs (CI, `/loop`, scheduled or autonomous runs, subagents). There, write the open questions into the report as blockers instead of guessing.

## The process

### 1. Hypothesis with a confidence number

Read the code and context first; never ask what you can find out yourself. Then write your best read in one sentence and an honest confidence:

```
HYPOTHESIS: You want to know which experiments are running, and "dashboard" was the first word that came to mind.
CONFIDENCE: ~30%, missing who it is for and what success looks like
```

Below about 70%, name what is missing on the same line.

### 2. One question at a time, each with a guess

```
Q: <one focused question>
GUESS: <your answer for them, and why>
```

Wait for the answer before the next question. Batches get skimmed, and the third question often depends on the first. A guess is faster to correct than an answer is to invent. Use AskUserQuestion when the answer is a choice between a few options, with your guess first and marked "(Recommended)".

Guard against a polite yes: now and then guess in a direction you expect them to push back on.

### 3. Listen for "want" versus "should want"

Watch for answers that sound like best practice ("scalable", "clean", "the standard way", "I should probably..."). Ask: "If you didn't have to justify this to anyone, what would you actually want?"

### 4. Restate the intent

When you can predict their reaction to the next three questions you would ask, stop asking and write back, in their words:

```
- Outcome:      <one line>
- User:         <who benefits>
- Why now:      <what changed>
- Success:      <how we know it worked>
- Constraint:   <the binding limit: time, scope, compatibility, cost>
- Out of scope: <what we are not doing>

Yes, no, or refine?
```

"Out of scope" is never left out; half of all misalignment is about what is not being built.

### 5. Get an explicit yes

These are not yes: "whatever you think" (offer two concrete options as a choice), "sounds good" (ask "anything you'd refine?"), "sure, let's go" or silence (ask whether something was missed). Fold each correction in and restate.

### 6. Hand off

After the yes, the confirmed intent is the first section of the plan. In `doing-substantial-work`, write the plan from it and show it for approval as usual; copy the six lines into the plan file. Do not start building on the interview's yes alone: the plan still needs its own approval.

If you have asked about six questions and still cannot predict their answers, stop and say so: "Something foundational is missing. Want to step back?"

## Red flags

- More than one question in a message.
- A question with no guess attached.
- A confidence below 70% with no reason.
- Accepting "whatever you think" as the answer.
- A plan or code before the restate got an explicit yes.
- A restate without "Out of scope".
- Three rounds without your confidence rising: you are asking the wrong questions.
