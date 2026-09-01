# 1. Runtime Spine

The spine is a continuous event processor. It applies one event at a time, schedules asynchronous
work into slots, and later consumes that work's progress or terminal event. The loop body never
waits for an executor.

This yields stable ownership:

- the event queue orders facts;
- slots enforce single-flight constraints;
- delegates identify outstanding work;
- wake reasons preserve causality;
- Floor prevents simultaneous user-facing responses.

A slow task and a new user turn can therefore coexist without inventing nested turns or a workflow
interpreter.
