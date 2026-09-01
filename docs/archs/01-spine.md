# 1. Runtime Spine

The spine is a continuous event processor. It applies one event at a time, schedules model work into
single-flight slots, and starts executor work as owned tasks identified by delegates. The loop body
never waits for an executor.

This yields stable ownership:

- the event queue orders facts;
- model slots (`fast`, `surrogate.watch`, `compress`) enforce single-flight constraints;
- delegates identify outstanding executor work;
- wake reasons preserve causality;
- Floor prevents simultaneous user-facing responses.

A slow task and a new user turn can therefore coexist without inventing nested turns or a workflow
interpreter.
