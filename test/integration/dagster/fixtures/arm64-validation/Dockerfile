FROM public.ecr.aws/docker/library/python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DAGSTER_HOME=/opt/dagster/dagster_home

WORKDIR /opt/dagster/app

RUN python -m pip install --no-cache-dir --upgrade pip && \
    python -m pip install --no-cache-dir \
      dagster==1.13.8 \
      dagster-webserver==1.13.8 \
      dagster-graphql==1.13.8 \
      dagster-k8s==0.29.8 \
      dagster-postgres==0.29.8

COPY definitions.py /opt/dagster/app/definitions.py

RUN mkdir -p /opt/dagster/dagster_home

EXPOSE 3030 3000

CMD ["dagster", "api", "grpc", "-h", "0.0.0.0", "-p", "3030", "-f", "/opt/dagster/app/definitions.py"]
