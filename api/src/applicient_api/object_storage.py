"""M3 §1 — thin S3-compatible client against MinIO.

`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET` have existed
in `.env.example` since M0, provisioned in docker-compose, but nothing
ever wrote to them until now (confirmed: `Profile.raw_cv_object_key`
was only ever set to `None`).

Two callers so far: the CV-upload backfill (`cv.py`) and the LaTeX
renderer (M3 §3) — both just need put/get-bytes-by-key, so the client
stays exactly that, not a general-purpose S3 wrapper. `delete_prefix`
(Phase 11 v2 plan follow-up) is the first real delete need — deleting
an interview-practice session removes its stored turn audio too,
rather than leaving orphaned objects in the bucket forever.
"""

from __future__ import annotations

import os

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

_client = None
_bucket: str | None = None


def _get_client():
    global _client, _bucket
    if _client is None:
        endpoint = os.environ.get("S3_ENDPOINT")
        access_key = os.environ.get("S3_ACCESS_KEY")
        secret_key = os.environ.get("S3_SECRET_KEY")
        bucket = os.environ.get("S3_BUCKET")
        if not all([endpoint, access_key, secret_key, bucket]):
            raise RuntimeError(
                "S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET are not fully set — copy .env.example to .env"
            )
        _client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            # MinIO is path-style only (bucket.endpoint virtual-hosted
            # style needs real DNS, which local MinIO doesn't have) —
            # confirmed live: virtual-hosted style 404s against this
            # container, path-style works.
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
            region_name="us-east-1",
        )
        _bucket = bucket
        _ensure_bucket()
    return _client


def _ensure_bucket() -> None:
    """MinIO does not auto-create the configured bucket — confirmed
    live: put_object against a fresh container 404s with NoSuchBucket
    until create_bucket is called once. Idempotent: create_bucket on
    an existing bucket this credential owns is a no-op error we catch
    and ignore, not a startup-order hazard."""

    assert _client is not None and _bucket is not None
    try:
        _client.head_bucket(Bucket=_bucket)
    except ClientError:
        _client.create_bucket(Bucket=_bucket)


def put_object(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    client = _get_client()
    client.put_object(Bucket=_bucket, Key=key, Body=data, ContentType=content_type)


def get_object(key: str) -> bytes:
    client = _get_client()
    return client.get_object(Bucket=_bucket, Key=key)["Body"].read()


def delete_prefix(prefix: str) -> None:
    """Deletes every object under `prefix` (e.g.
    `interview-audio/{session_id}/`) — list_objects_v2 + a batch
    delete_objects call, paginated since a single delete_objects call
    caps at 1000 keys (a real interview session has at most a few
    dozen turns, but this stays correct regardless). A no-op, not an
    error, if the prefix has nothing under it — deleting a session
    whose synthesis always failed (text-only, no audio ever stored)
    is a normal case, not a bug."""

    client = _get_client()
    continuation_token: str | None = None
    while True:
        kwargs = {"Bucket": _bucket, "Prefix": prefix}
        if continuation_token:
            kwargs["ContinuationToken"] = continuation_token
        listing = client.list_objects_v2(**kwargs)
        keys = [obj["Key"] for obj in listing.get("Contents", [])]
        if keys:
            client.delete_objects(Bucket=_bucket, Delete={"Objects": [{"Key": k} for k in keys]})
        if not listing.get("IsTruncated"):
            break
        continuation_token = listing.get("NextContinuationToken")
