# Isolated Python runner. Runs with no network, a read-only filesystem and dropped capabilities (see docker-compose.yml).
FROM python:3.12-slim
RUN groupadd -g 10001 runner && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin runner \
 && rm -rf /var/lib/apt/lists/* /root/.cache
COPY server.py /sandbox/server.py
ENV SANDBOX_SOCKET=/sock/sandbox.sock SANDBOX_RUN_UID=10001 PYTHONDONTWRITEBYTECODE=1
# The service starts as root only so each run can switch to the unprivileged "runner" user.
CMD ["python3", "-I", "/sandbox/server.py"]
