from dagster import Definitions, asset


@asset
def validation_asset() -> str:
    return "ok"


defs = Definitions(assets=[validation_asset])
