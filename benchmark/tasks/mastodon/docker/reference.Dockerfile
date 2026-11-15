# HIDDEN reference image (evaluator / checks stream only, never given to a coding run):
# `frugal-task-<taskId>-ref:<hash>` = the task image + the upstream feature diff
# (evaluator/tasks/<taskId>/reference.diff) applied to /workspace and staged (`git diff --cached`
# shows the reference; HEAD is still the checkpoint). The DB template still holds the checkpoint
# schema: `app start` migrates development, rspec's maintain_test_schema loads db/schema.rb into test.
# The diff is bind-mounted for the RUN only, so it is not a separate layer file.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER node
WORKDIR /workspace
RUN --mount=type=bind,source=reference.diff,target=/mnt/reference.diff \
    git apply --index --whitespace=nowarn /mnt/reference.diff \
 && git diff --cached --stat | tail -n 1
CMD ["sleep", "infinity"]
