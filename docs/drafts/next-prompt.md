# Design Review #

You are acting as a senior product team inheriting an existing Pokémon GO companion application from another developer.

Your job is NOT to immediately redesign the app.

Your first responsibility is to understand whether the current problems come from:

- poor product decisions
- poor UX decisions
- inconsistent design language
- incomplete Vue migration
- component architecture problems
- technical debt
- incorrect assumptions about future direction

Only recommend a redesign if the existing problems cannot be solved through architecture, component refactoring, or targeted improvements.

Act as a team consisting of:

1. Principal Product Designer

- Modern mobile UX expert
- 2026 application design trends
- Android and desktop application design
- Accessibility
- Information-heavy applications

1. Pokémon GO Power User / Domain Expert

- Deep understanding of Pokémon GO players
- Shiny hunters
- Living dex collectors
- PvP players
- Raid players
- Lucky trade collectors
- Shadow Pokémon
- Costumes
- Regional Pokémon
- Event-driven gameplay
- Pokémon storage frustrations

1. Senior Frontend Architect

- Vue 3 architecture
- Component-driven design
- Cross-platform application architecture
- Desktop and mobile UX tradeoffs
- Local-first applications

1. Product Manager

- Challenges assumptions
- Reviews roadmap decisions
- Identifies unnecessary complexity
- Prioritizes user value over technical attachment

---

## Project Context

This application is a personal Pokémon GO collection companion.

It is not simply a Pokédex.

The core value is helping a player understand, manage, and progress their personal Pokémon collection.

The app should answer questions like:

- What Pokémon do I own?
- What am I missing?
- What should I work on next?
- Which Pokémon are valuable?
- Which Pokémon should I evolve, trade, power up, or keep?
- How complete is my collection?
- What milestones have I achieved?

The goal is a companion for someone who has spent years building a Pokémon GO collection.

---

## Current Technical Context

Current technology:

- Vue 3
- Tauri
- SQLite
- Drizzle ORM

Primary platforms:

- Android
- Arch Linux desktop

Web support is no longer a primary requirement.

Do not assume the current stack must remain.

Evaluate whether it is still the correct choice.

Consider alternatives such as Flutter or other approaches if they provide meaningful advantages.

However, do not recommend rewrites without strong justification.

---

## Phase 1: Inherited Codebase Audit

Before discussing redesign, act as if you inherited this codebase from another developer.

Answer:

"If I inherited this project today, what would I refactor before adding any new features?"

Analyze:

### Component Architecture

Identify:

- Components that should exist but do not
- Large components that should be split
- Repeated UI patterns
- Inconsistent implementations of the same concept
- Missing shared design primitives

Look for opportunities to create reusable components such as:

- Pokémon cards
- badges
- filters
- search components
- stat displays
- empty states
- progress indicators
- dialogs
- navigation patterns

Determine whether the current design issues are actually caused by missing component structure.

---

## Design System Audit

Determine:

- Are spacing rules consistent?
- Are typography patterns consistent?
- Are colors used consistently?
- Are cards/buttons/lists visually related?
- Does the application feel like one product?

Identify whether the current "off" feeling comes from:

- visual choices
- inconsistent components
- incomplete migration
- lack of design system

---

## Technical Debt Audit

Review:

- State management
- Database interaction patterns
- Data flow
- Performance concerns
- Maintainability
- Scalability

Recommend changes that improve the product without unnecessary rewrites.

---

# Phase 2: Post-Refactor Evaluation

After identifying refactoring opportunities, answer:

"After these changes, does this application still require a major design rethink?"

Consider three outcomes:

## Outcome A

The existing design is fundamentally good.

Recommendation:

- Keep the direction
- Improve consistency
- Continue building

## Outcome B

The architecture is the main problem.

Recommendation:

- Refactor components/design system
- Keep existing UX direction

## Outcome C

The product experience is still fundamentally limited.

Recommendation:

- Proceed with a broader UX redesign

Do not recommend a redesign simply because a redesign is possible.

---

# Phase 3: Product and Feature Review

Regardless of redesign outcome, review the product direction.

Analyze:

- Current features
- Planned features
- Existing roadmap

Categorize:

KEEP:
Features that provide strong user value.

CHANGE:
Features with good ideas but poor execution.

REMOVE:
Features adding complexity without meaningful value.

DEFER:
Features worth revisiting later.

Challenge assumptions.

Do not preserve features simply because they were previously planned.

---

# Phase 4: Pokémon GO Player Review

Evaluate the application as a Pokémon GO power user.

Ask:

Does this actually solve problems players have?

Consider:

- Living dex management
- Shiny tracking
- Forms and costumes
- Collection goals
- Evolution planning
- Trade decisions
- Lucky Pokémon
- PvP collection
- Event preparation
- Progress tracking

Identify missing workflows.

---

# Data Architecture Review

There are two categories of data.

## Reference Data

This represents Pokémon information:

- Species
- Forms
- Variants
- Evolution chains
- Moves
- Other metadata

Important:

The current reference data source is not final.

Do not optimize around current limitations.

Evaluate:

- Required information
- Future flexibility
- Data ingestion strategy
- Update strategy
- Normalization decisions

---

## User Data

User data represents the player's collection.

This area has received significant design effort and is considered close to a good solution.

Treat it as a strong foundation.

Critique it, but do not casually replace it.

Evaluate whether it supports:

- Collection ownership
- Shiny status
- Lucky status
- Shadow/Purified state
- IV information
- Notes
- Favorites
- History
- Goals
- Future automation
- Multi-device synchronization

---

# Local-First Philosophy

The application should remain usable without accounts or cloud dependency.

However, consider future optional device-to-device synchronization.

Evaluate how architecture should support:

- Local-first usage
- LAN synchronization
- QR pairing
- Device discovery
- Conflict resolution
- Future cloud sync if desired

Do not make synchronization mandatory, but ensure current decisions do not prevent it.

---

# Design Language Review

If a redesign is still needed:

Do not blindly use one existing design system.

Evaluate modern design approaches:

- Android design patterns
- Apple design language
- Modern desktop application patterns
- Other 2026 consumer application trends

Recommend the visual language that best fits a premium Pokémon GO companion application.

Explain why.

---

# Future Capabilities

Consider whether the architecture supports:

- OCR/screenshot scanning
- Local image recognition
- AI-assisted search
- Natural language queries

Examples:

"Show me Pokémon I should evolve."

"What shiny Pokémon am I missing?"

"Find my best Pokémon under 1500 CP."

"Which Pokémon should I trade?"

---

# Final Deliverables

Provide:

1. Executive summary:

- What is actually wrong?
- What should happen next?

1. Refactoring plan:

- Highest value improvements first

1. Product roadmap review:

- Keep/change/remove/defer

1. Decision:

- Does this require a redesign?
- A targeted UX improvement?
- Or primarily architecture cleanup?

1. If redesign is required:
Provide:

- New information architecture
- User flows
- Navigation
- Screen concepts
- Design principles

Do not jump into implementation until the direction is validated.

The priority order is:

1. Preserve user value
2. Improve maintainability
3. Create a coherent product experience
4. Avoid unnecessary rewrites
5. Build the best Pokémon GO companion possible for 2026
