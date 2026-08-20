# Over-Engineering Checklist

A focus checklist for the simplify review agent: the over-engineering mistakes
AI coding agents most often introduce. Check every change against these; a match
is a simplification opportunity.

## 1. Unnecessary abstraction / pass-through indirection

Wrapper classes that only delegate, an interface / abstract class / protocol with a
single implementation, a factory that always returns the same type, or
Service → Repository → DB chains where one function would do.

**Signal**: a class or function that just calls another with the same signature, adding
nothing.

## 2. Premature generalization (YAGNI)

Generic or parameterized code for use cases that don't exist yet, config
flags / options / env vars for hypothetical scenarios, "for future extensibility" seams.

**Signal**: parameters, branches, or options nobody currently uses.

## 3. Design patterns for their own sake

Strategy / Visitor / Builder / Observer / Singleton / DI container where a plain
function or an `if`/`switch` would do.

**Signal**: pattern machinery with exactly one concrete path.

## 4. Premature architecture / over-modularization

Extra layers (hexagonal / clean / microservices / plugins) before the requirements
justify them, too many files / modules / classes for the feature's size, components
for unspecified edge cases or scale.

**Signal**: an architecture diagram or component that doesn't map to a specific requirement.

## 5. Premature optimization

Caching, memoization, async / parallelism, connection pools, or indexing before
measuring; "scalability" code before knowing the scale.

**Signal**: complexity justified by performance with no benchmark.

## 6. Speculative features (gold-plating)

Unrequested features, "future-proofing", handling edge cases that cannot occur.

**Signal**: a code path no requirement or acceptance criterion covers.

## 7. Excessive defensive programming

Impossible null / error branches, over-validation, elaborate error hierarchies for
simple cases.

**Signal**: guards for states that cannot actually occur.

## 8. Reinventing the wheel / unnecessary dependencies

Reimplementing stdlib or an already-present dependency; adding a library for
something a few lines would do.

**Signal**: custom code duplicating a standard or well-known function, or a new dep for a
trivial task.

## 9. Boilerplate ceremony

Builders / DTOs / mappers / converters that just copy fields; excessive scaffolding,
getters / setters, ceremony.

**Signal**: code whose only job is moving data verbatim.

## 10. Copy-paste drift (duplication)

Three or more nearly identical blocks or functions that should be one parameterized
function.

**Signal**: the same shape repeated with only a name or type changed.
