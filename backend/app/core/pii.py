"""Personal data protection: encryption at rest and tokenisation.

  * Encryption. Inbound payloads (what Nova sends, frozen with each decision)
    are stored with AES-256-GCM. `EncryptedText` is a column type, so code
    reads and writes plain text and the database only ever holds ciphertext.
    Values written before encryption was switched on stay readable.
  * Tokenisation. Traces, logs and anything an agent reads carry a keyed
    token (HMAC-SHA256) instead of a name or account number. The same input
    always gives the same token, so a trace can still be followed, but the
    token cannot be turned back into the identifier without the key.

The key is ARI_PII_KEY (32 bytes, base64) in the environment. Without it, ARI
creates a local key file next to the backend so a developer machine works;
production sets the environment variable from the bank's key vault.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.types import Text, TypeDecorator

from .config import BACKEND_DIR

PREFIX = "enc:v1:"
KEY_FILE = os.path.join(BACKEND_DIR, ".ari_pii_key")


def _load_key() -> tuple[bytes, str]:
    env = os.getenv("ARI_PII_KEY", "").strip()
    if env:
        key = base64.b64decode(env)
        if len(key) != 32:
            raise ValueError("ARI_PII_KEY must be 32 bytes, base64-encoded.")
        return key, "environment"
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "rb") as f:
            return base64.b64decode(f.read().strip()), "local key file"
    key = secrets.token_bytes(32)
    with open(KEY_FILE, "wb") as f:
        f.write(base64.b64encode(key))
    return key, "local key file"


_KEY, KEY_SOURCE = _load_key()
# Separate keys for the two jobs, derived from the one master key.
_ENC_KEY = hmac.new(_KEY, b"ari-encrypt-v1", hashlib.sha256).digest()
_TOK_KEY = hmac.new(_KEY, b"ari-tokenise-v1", hashlib.sha256).digest()
KEY_ID = hashlib.sha256(_ENC_KEY).hexdigest()[:8]   # identifies the key without revealing it


def encrypt(plain: str) -> str:
    nonce = secrets.token_bytes(12)
    ct = AESGCM(_ENC_KEY).encrypt(nonce, plain.encode("utf-8"), KEY_ID.encode())
    return PREFIX + base64.b64encode(nonce + ct).decode()


def decrypt(stored: str) -> str:
    if not stored.startswith(PREFIX):
        return stored   # written before encryption was switched on
    raw = base64.b64decode(stored[len(PREFIX):])
    try:
        return AESGCM(_ENC_KEY).decrypt(raw[:12], raw[12:], KEY_ID.encode()).decode("utf-8")
    except Exception:   # a different key: unreadable, never a crash
        return "{}"


def is_encrypted(stored: str | None) -> bool:
    return bool(stored) and stored.startswith(PREFIX)


def token(value: object, kind: str = "id") -> str:
    """A stable, keyed stand-in for an identifier, e.g. tok_3f9a1c07b2d4."""
    digest = hmac.new(_TOK_KEY, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()
    return f"tok_{digest[:12]}"


class EncryptedText(TypeDecorator):
    """Text that is encrypted before it reaches the database."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return None if value is None else encrypt(value)

    def process_result_value(self, value, dialect):
        return None if value is None else decrypt(value)
