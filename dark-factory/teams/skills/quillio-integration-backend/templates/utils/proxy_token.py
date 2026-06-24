"""Short-lived JWT proxy tokens for <partner> document downloads.

Drop into: modules/integrations/<partner>/backend/utils/proxy_token.py
Skip this file if your integration does not need a download proxy.
"""
from datetime import datetime, timedelta

import jwt

from app.settings import settings

PROXY_TOKEN_TTL_SECONDS = 300  # 5 minutes
PROXY_TOKEN_PURPOSE = "<partner>_proxy"


def create_proxy_token(user_email: str, document_id: str) -> str:
    payload = {
        "sub": user_email,
        "doc": document_id,
        "exp": datetime.utcnow()
        + timedelta(seconds=PROXY_TOKEN_TTL_SECONDS),
        "purpose": PROXY_TOKEN_PURPOSE,
    }
    return jwt.encode(
        payload, settings.authjwt_secret_key, algorithm="HS256"
    )


def verify_proxy_token(
    token: str,
    user_email: str,
    document_id: str,
) -> bool:
    try:
        payload = jwt.decode(
            token,
            settings.authjwt_secret_key,
            algorithms=["HS256"],
            options={"require": ["exp", "sub", "doc", "purpose"]},
        )
    except jwt.ExpiredSignatureError:
        return False
    except jwt.InvalidTokenError:
        return False

    if payload.get("purpose") != PROXY_TOKEN_PURPOSE:
        return False
    if payload.get("sub") != user_email:
        return False
    if payload.get("doc") != document_id:
        return False
    return True
