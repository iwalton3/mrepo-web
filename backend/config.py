"""
Configuration management for mrepo.

Loads configuration from YAML file with environment variable overrides.
"""

import os
import secrets
from pathlib import Path

import yaml


class Config:
    """Application configuration."""

    def __init__(self):
        self._config = {}
        self._loaded = False

    def load(self, path=None):
        """Load configuration from file and environment variables."""
        if path is None:
            # Check environment variable first
            path = os.environ.get('MREPO_CONFIG')

            if not path:
                # Try config.yaml in current directory, then /etc/mrepo/config.yaml
                local_config = Path('config.yaml')
                if local_config.exists():
                    path = str(local_config)
                else:
                    path = '/etc/mrepo/config.yaml'

        # Load YAML file if it exists
        config_path = Path(path)
        if config_path.exists():
            with open(config_path) as f:
                self._config = yaml.safe_load(f) or {}

        # Apply environment variable overrides
        self._apply_env_overrides()

        # Set defaults for required values
        self._set_defaults()

        self._loaded = True

    def _apply_env_overrides(self):
        """Apply environment variable overrides."""
        env_mapping = {
            'DATABASE_PATH': ('database', 'path'),
            'MEDIA_PATH': ('media', 'paths'),  # Single path from env
            'SECRET_KEY': ('auth', 'secret_key'),
            'FFMPEG_PATH': ('streaming', 'ffmpeg_path'),
            'ALLOW_REGISTRATION': ('auth', 'allow_registration'),
            'BASE_PATH': ('app', 'base_path'),
        }

        for env_var, path in env_mapping.items():
            value = os.environ.get(env_var)
            if value is not None:
                # Handle special cases
                if env_var == 'MEDIA_PATH':
                    # Convert single path to list
                    value = [value]
                elif env_var == 'ALLOW_REGISTRATION':
                    value = value.lower() in ('true', '1', 'yes')

                self._set_nested(path, value)

    def _set_nested(self, path, value):
        """Set a nested configuration value."""
        current = self._config
        for key in path[:-1]:
            if key not in current:
                current[key] = {}
            current = current[key]
        current[path[-1]] = value

    def _get_nested(self, *path):
        """Get a nested value from _config without triggering load()."""
        value = self._config
        for key in path:
            if isinstance(value, dict) and key in value:
                value = value[key]
            else:
                return None
        return value

    def _set_defaults(self):
        """Set default values for required configuration."""
        defaults = {
            ('database', 'path'): 'data/music.db',
            ('database', 'timeout'): 30,
            ('media', 'paths'): ['/media'],
            ('streaming', 'url_prefix'): '/stream',
            ('streaming', 'transcode_bitrate'): '320k',
            ('streaming', 'ffmpeg_path'): 'ffmpeg',
            ('auth', 'session_days'): 30,
            ('auth', 'allow_registration'): False,
            ('app', 'base_path'): '',  # e.g., '/music' for hosting at /music/
        }

        for path, default in defaults.items():
            if self._get_nested(*path) is None:
                self._set_nested(path, default)

        # Handle secret key - check config/env, then file, then generate
        if not self._get_nested('auth', 'secret_key'):
            secret_key = self._get_or_create_secret_key()
            self._set_nested(('auth', 'secret_key'), secret_key)

    def _get_or_create_secret_key(self):
        """Get secret key from file or generate and store a new one."""
        # Store in same directory as database
        db_path = Path(self._get_nested('database', 'path'))
        secret_file = db_path.parent / '.secret_key'

        # Try to read existing key
        if secret_file.exists():
            try:
                key = secret_file.read_text().strip()
                if len(key) >= 32:
                    return key
            except Exception:
                pass

        # Generate new key
        key = secrets.token_hex(32)

        # Try to save it (create directory if needed)
        try:
            secret_file.parent.mkdir(parents=True, exist_ok=True)
            secret_file.write_text(key)
            # Restrict permissions
            secret_file.chmod(0o600)
        except Exception:
            # If we can't save, still return the key (will regenerate on restart)
            pass

        return key

    def get(self, *path, default=None):
        """Get a configuration value by path."""
        if not self._loaded:
            self.load()

        value = self._config
        for key in path:
            if isinstance(value, dict) and key in value:
                value = value[key]
            else:
                return default
        return value

    def get_flask_config(self):
        """Get configuration suitable for Flask app.config."""
        return {
            'SECRET_KEY': self.get('auth', 'secret_key'),
            'SESSION_COOKIE_HTTPONLY': True,
            'SESSION_COOKIE_SAMESITE': 'Lax',
            'PERMANENT_SESSION_LIFETIME': self.get('auth', 'session_days') * 86400,

            # Custom config keys
            'DATABASE_PATH': self.get('database', 'path'),
            'DATABASE_TIMEOUT': self.get('database', 'timeout'),
            'MEDIA_PATHS': self.get('media', 'paths'),
            'STREAM_URL_PREFIX': self.get('streaming', 'url_prefix'),
            'TRANSCODE_BITRATE': self.get('streaming', 'transcode_bitrate'),
            'FFMPEG_PATH': self.get('streaming', 'ffmpeg_path'),
            'ALLOW_REGISTRATION': self.get('auth', 'allow_registration'),
            'BASE_PATH': self.get('app', 'base_path'),
        }


# Global configuration instance
config = Config()
