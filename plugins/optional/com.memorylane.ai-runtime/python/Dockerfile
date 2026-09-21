FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY memorylane_ai ./memorylane_ai
RUN pip install --no-cache-dir .
ENV MEMORYLANE_AI_HOST=0.0.0.0 MEMORYLANE_AI_PORT=4281
EXPOSE 4281
CMD ["memorylane-ai"]
