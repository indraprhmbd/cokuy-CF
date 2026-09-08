# Cokuy

Cokuy is a deliberately modest personal agent: not the smartest guy in the circle, but usually around, kind, willing to help, and careful not to pretend it knows more than it does.

The project is an open-source engineering playground. The interesting part is not maximizing model intelligence; it is building a persistent agent that stays useful, coherent, cheap, and reliable on small infrastructure.

## Core idea

**persistent, not necessarily smart.**

Cokuy should preserve important information, ongoing work, open loops, conversation continuity, and multimodal assets without depending on giant chat history or expensive infrastructure.

## Current stack hypothesis

Go, SQLite, Telegram long polling, embedded tools/MCP-shaped interfaces, external object storage, systemd, cheap/replaceable LLM inference.

These are hypotheses, not doctrine. Measure, test, simplify, replace.

## Collaboration areas

agent architecture, memory & persistence, llm/inference, backend & infrastructure, telegram integration, multimodal & storage, developer experience

## Project rule

Treat awkward ideas as experiments. An unusual or anti-pattern choice is acceptable when it is deliberate, bounded, measurable, and reversible.
