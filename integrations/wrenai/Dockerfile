FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
WORKDIR /opt/wren
COPY requirements-runtime-lock.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements-runtime-lock.txt
COPY upstream/runtime ./upstream/runtime
COPY upstream/licenses ./upstream/licenses
COPY THIRD_PARTY_NOTICES.md ./
COPY models ./models
COPY bridge/plan_worker.py bridge/query_service.py ./bridge/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WREN_SERVICE_HOST=0.0.0.0
USER 65532:65532
CMD ["python", "-B", "bridge/query_service.py"]
