"""
Flask application factory and API dispatcher for mrepo.

Maintains JSON-RPC style API compatibility with the original frontend.
"""

import json
import os
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, Response

from .config import config
from .db import get_db, close_db, init_db
from .auth import (
    get_current_user, has_capability, is_setup_required,
    create_user, authenticate_user, login_user, logout_user, list_users,
    update_user, delete_user
)


# API method registry
# Maps method names to (handler_func, config_dict)
API_METHODS = {}


def api_method(name, require='user', public=False):
    """Decorator to register an API method.

    Args:
        name: The method name as called from frontend
        require: Required capability ('user', 'admin', None)
        public: If True, method is accessible without authentication
    """
    def decorator(fn):
        API_METHODS[name] = {
            'handler': fn,
            'require': require,
            'public': public
        }
        return fn
    return decorator


def create_app(config_path=None):
    """Create and configure the Flask application."""

    # Load configuration
    if config_path:
        config.load(config_path)
    else:
        config.load()

    # Determine frontend path
    # In development: ../frontend relative to backend/
    # In production: configured or default /app/frontend
    backend_dir = Path(__file__).parent
    frontend_dir = backend_dir.parent / 'frontend'
    if not frontend_dir.exists():
        frontend_dir = Path('/app/frontend')

    app = Flask(__name__,
                static_folder=str(frontend_dir),
                static_url_path='')

    # Apply configuration
    app.config.update(config.get_flask_config())

    # Register teardown
    app.teardown_appcontext(close_db)

    # Initialize database
    init_db(app)

    # Import API modules to register their methods
    _register_api_modules()

    # Register built-in auth methods
    _register_auth_methods()

    # -------------------------------------------------------------------
    # Routes
    # -------------------------------------------------------------------

    @app.route('/')
    def index():
        """Serve the main application."""
        # Check if setup is required
        if is_setup_required():
            return send_from_directory(app.static_folder, 'index.html')
        return send_from_directory(app.static_folder, 'index.html')

    @app.route('/config.js')
    def serve_config():
        """Serve runtime configuration for frontend."""
        # Check if transcoding is available
        from .streaming import ffmpeg_available, TRANSCODE_FORMATS

        base_path = app.config.get('BASE_PATH', '')
        js_config = {
            'basePath': base_path,
            'apiBase': f'{base_path}/api/',
            'streamBase': f'{base_path}{app.config["STREAM_URL_PREFIX"]}/',
            'transcodeEnabled': ffmpeg_available(),
            'transcodeFormats': list(TRANSCODE_FORMATS) if ffmpeg_available() else [],
            'setupRequired': is_setup_required(),
        }

        js_content = f'window.MREPO_CONFIG = {json.dumps(js_config)};'
        return Response(js_content, mimetype='application/javascript')

    @app.route('/api/', methods=['POST'])
    def api_handler():
        """Main API endpoint - JSON-RPC style dispatcher."""
        try:
            data = request.get_json()
        except Exception:
            return jsonify({'success': False, 'error': 'InvalidJSON'})

        if not data:
            return jsonify({'success': False, 'error': 'NoData'})

        method_name = data.get('method')
        kwargs = data.get('kwargs', {})

        if not method_name:
            return jsonify({'success': False, 'error': 'NoMethod'})

        # Look up method
        method_config = API_METHODS.get(method_name)
        if not method_config:
            return jsonify({'success': False, 'error': 'MethodNotFound',
                          'message': f'Unknown method: {method_name}'})

        handler = method_config['handler']
        require = method_config['require']
        public = method_config.get('public', False)

        # Check authentication
        user = get_current_user()

        if not public and not user:
            return jsonify({'success': False, 'error': 'NotAuthenticated'})

        # Check capability
        if require and not has_capability(user, require):
            return jsonify({'success': False, 'error': 'NotAuthorized'})

        # Inject user info if handler expects it
        import inspect
        sig = inspect.signature(handler)
        if 'details' in sig.parameters:
            kwargs['details'] = {
                'user': user['username'] if user else None,
                'user_id': user['id'] if user else None,
                'capabilities': user['capabilities'] if user else []
            }

        # Call handler
        try:
            result = handler(**kwargs)
            return jsonify({'success': True, 'result': result})
        except TypeError as e:
            # Parameter mismatch
            return jsonify({'success': False, 'error': 'InvalidParameters',
                          'message': str(e)})
        except ValueError as e:
            return jsonify({'success': False, 'error': 'ValueError',
                          'message': str(e)})
        except Exception as e:
            app.logger.exception(f'API error in {method_name}')
            return jsonify({'success': False, 'error': 'InternalError',
                          'message': str(e)})

    # Register streaming blueprint
    from .streaming import bp as streaming_bp
    app.register_blueprint(streaming_bp)

    # Serve static files (frontend)
    @app.route('/<path:path>')
    def serve_static(path):
        """Serve static frontend files."""
        return send_from_directory(app.static_folder, path)

    return app


def _register_api_modules():
    """Import all API modules to register their methods."""
    # Import each API module - they register methods via @api_method decorator
    try:
        from .api import songs
        from .api import browse
        from .api import playlists
        from .api import queue
        from .api import playback
        from .api import radio
        from .api import history
        from .api import preferences
        from .api import sync
        from .api import admin
        from .api import tags
    except ImportError as e:
        # Some modules may not exist yet during development
        pass


def _register_auth_methods():
    """Register authentication-related API methods."""

    @api_method('check_user', require=None, public=True)
    def check_user():
        """Check current authentication status."""
        user = get_current_user()
        if user:
            return {
                'authenticated': True,
                'user': user['username'],
                'capabilities': user['capabilities']
            }
        return {
            'authenticated': False,
            'setupRequired': is_setup_required()
        }

    @api_method('auth_login', require=None, public=True)
    def auth_login(username, password):
        """Log in with username and password."""
        user = authenticate_user(username, password)
        if not user:
            raise ValueError('Invalid username or password')
        login_user(user)
        return {
            'user': user['username'],
            'capabilities': user['capabilities']
        }

    @api_method('auth_logout', require=None, public=True)
    def auth_logout():
        """Log out current user."""
        logout_user()
        return {'success': True}

    @api_method('auth_register', require=None, public=True)
    def auth_register(username, password):
        """Register a new user (only during setup or if registration enabled)."""
        from flask import current_app

        # Allow registration during setup or if explicitly enabled
        if not is_setup_required() and not current_app.config.get('ALLOW_REGISTRATION'):
            raise ValueError('Registration is disabled')

        # First user gets admin capabilities (admin implies user)
        capabilities = 'admin' if is_setup_required() else 'user'

        user_id = create_user(username, password, capabilities)

        # Auto-login after registration
        user = {
            'id': user_id,
            'username': username,
            'capabilities': capabilities.split(',')
        }
        login_user(user)

        return {
            'user': username,
            'capabilities': user['capabilities']
        }

    @api_method('auth_change_password', require='user')
    def auth_change_password(current_password, new_password, details=None):
        """Change the current user's password."""
        from .auth import verify_password, hash_password

        db = get_db()
        cur = db.cursor()
        cur.execute('SELECT password_hash FROM users WHERE id = ?', (details['user_id'],))
        row = cur.fetchone()

        if not row or not verify_password(current_password, row['password_hash']):
            raise ValueError('Current password is incorrect')

        if len(new_password) < 8:
            raise ValueError('New password must be at least 8 characters')

        cur.execute('UPDATE users SET password_hash = ? WHERE id = ?',
                   (hash_password(new_password), details['user_id']))

        return {'success': True}

    @api_method('users_list', require='admin')
    def users_list_api():
        """List all users (admin only)."""
        return list_users()

    @api_method('users_create', require='admin')
    def users_create(username, password, capabilities='user'):
        """Create a new user (admin only)."""
        user_id = create_user(username, password, capabilities)
        return {'id': user_id, 'username': username}

    @api_method('users_update', require='admin')
    def users_update(user_id, username=None, password=None, capabilities=None):
        """Update a user (admin only)."""
        update_user(user_id, username, password, capabilities)
        return {'success': True}

    @api_method('users_delete', require='admin')
    def users_delete(user_id, details=None):
        """Delete a user (admin only)."""
        from .db import get_db

        # Check if trying to delete self
        if str(user_id) == str(details['user_id']):
            # Only allow if there's another admin
            conn = get_db()
            cur = conn.cursor()
            cur.execute("""
                SELECT COUNT(*) FROM users
                WHERE capabilities = 'admin' AND id != ?
            """, (user_id,))
            other_admins = cur.fetchone()[0]
            if other_admins == 0:
                raise ValueError('Cannot delete the only admin account')

        delete_user(user_id)
        return {'success': True}


# For running with gunicorn
def create_app_wsgi():
    """Create app for WSGI server."""
    return create_app()


if __name__ == '__main__':
    app = create_app()
    app.run(debug=True, host='0.0.0.0', port=8080)
