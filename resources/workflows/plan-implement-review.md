# Team Strategy: Plan, Implement, Review

Deliver one cohesive change through a bounded plan, implementation, and review.

1. Read the current assignment, the plan (`ctxspace plan`) and relevant approved
   sources. Resolve important unknowns and write observable acceptance criteria in
   the existing plan. For a moved workspace, use `ctxspace plan apply` with stable ids.
   For a file-based workspace, edit `PLAN.md` directly.
2. If the assignment is investigation or design, return that stage's output and
   stop. Proceed to implementation only when the current user authorization covers it.
3. Implement the assigned outcome and test relevant behavior, including concrete
   failure and recovery paths. Preserve compatibility with existing consumers.
4. Review correctness, scope, usability where relevant, and verification evidence.
   Fix in-scope findings, rerun affected checks, and report remaining limitations.

One developer or agent can perform this loop. Use independent review or bounded
parallel work when available, authorized, and useful; a fixed agent topology is
not required. Reuse the same sources and plan across handoffs.
Read the current PR head and checks before declaring merge readiness.
