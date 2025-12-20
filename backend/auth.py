"""
Authentication and authorization for mrepo.

Uses Argon2 for password hashing and Flask sessions for authentication.
"""

import secrets
from datetime import datetime
from functools import wraps

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from flask import session, jsonify, request

from .db import get_db, row_to_dict


# Password hasher with secure defaults
ph = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=4
)


def hash_password(password):
    """Hash a password using Argon2id."""
    return ph.hash(password)


def verify_password(password, password_hash):
    """Verify a password against its hash."""
    try:
        ph.verify(password_hash, password)
        return True
    except VerifyMismatchError:
        return False


def get_current_user():
    """Get the current authenticated user from session."""
    user_id = session.get('user_id')
    if not user_id:
        return None

    db = get_db()
    cur = db.cursor()
    cur.execute('SELECT id, username, capabilities FROM users WHERE id = ?', (user_id,))
    row = cur.fetchone()
    if row:
        return {
            'id': row['id'],
            'username': row['username'],
            'capabilities': row['capabilities'].split(',') if row['capabilities'] else ['user']
        }
    return None


def has_capability(user, capability):
    """Check if a user has a specific capability."""
    if not user:
        return False

    capabilities = user.get('capabilities', [])

    # Capability hierarchy: root > admin > user
    if 'root' in capabilities:
        return True
    if capability == 'admin' and 'admin' in capabilities:
        return True
    if capability == 'user' and ('user' in capabilities or 'admin' in capabilities):
        return True

    return capability in capabilities


def require_auth(f):
    """Decorator to require authentication."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({'success': False, 'error': 'NotAuthenticated'}), 401
        return f(*args, **kwargs)
    return decorated


def require_capability(capability):
    """Decorator factory to require a specific capability."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            user = get_current_user()
            if not user:
                return jsonify({'success': False, 'error': 'NotAuthenticated'}), 401
            if not has_capability(user, capability):
                return jsonify({'success': False, 'error': 'NotAuthorized'}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def is_setup_required():
    """Check if initial setup is required (no users exist)."""
    db = get_db()
    cur = db.cursor()
    cur.execute('SELECT COUNT(*) FROM users')
    count = cur.fetchone()[0]
    return count == 0


def create_user(username, password, capabilities='user'):
    """Create a new user.

    Returns the user ID on success, raises exception on failure.
    """
    if not username or len(username) < 3:
        raise ValueError('Username must be at least 3 characters')
    if not password or len(password) < 8:
        raise ValueError('Password must be at least 8 characters')

    db = get_db()
    cur = db.cursor()

    # Check if username exists
    cur.execute('SELECT id FROM users WHERE username = ?', (username,))
    if cur.fetchone():
        raise ValueError('Username already exists')

    # Create user
    password_hash = hash_password(password)
    cur.execute(
        'INSERT INTO users (username, password_hash, capabilities) VALUES (?, ?, ?)',
        (username, password_hash, capabilities)
    )

    return cur.lastrowid


def authenticate_user(username, password):
    """Authenticate a user by username and password.

    Returns user dict on success, None on failure.
    """
    db = get_db()
    cur = db.cursor()
    cur.execute(
        'SELECT id, username, password_hash, capabilities FROM users WHERE username = ?',
        (username,)
    )
    row = cur.fetchone()

    if not row:
        return None

    if not verify_password(password, row['password_hash']):
        return None

    # Update last login
    cur.execute('UPDATE users SET last_login = ? WHERE id = ?',
                (datetime.utcnow(), row['id']))

    return {
        'id': row['id'],
        'username': row['username'],
        'capabilities': row['capabilities'].split(',') if row['capabilities'] else ['user']
    }


def login_user(user):
    """Log in a user by setting session data."""
    session.permanent = True
    session['user_id'] = user['id']
    session['username'] = user['username']
    session['capabilities'] = user['capabilities']


def logout_user():
    """Log out the current user."""
    session.clear()


def list_users():
    """List all users (admin only)."""
    db = get_db()
    cur = db.cursor()
    cur.execute('SELECT id, username, capabilities, created_at, last_login FROM users ORDER BY created_at')
    rows = cur.fetchall()
    return [row_to_dict(row) for row in rows]


def update_user(user_id, username=None, password=None, capabilities=None):
    """Update a user's information."""
    db = get_db()
    cur = db.cursor()

    updates = []
    params = []

    if username:
        # Check if new username is taken
        cur.execute('SELECT id FROM users WHERE username = ? AND id != ?', (username, user_id))
        if cur.fetchone():
            raise ValueError('Username already exists')
        updates.append('username = ?')
        params.append(username)

    if password:
        if len(password) < 8:
            raise ValueError('Password must be at least 8 characters')
        updates.append('password_hash = ?')
        params.append(hash_password(password))

    if capabilities is not None:
        updates.append('capabilities = ?')
        params.append(capabilities)

    if not updates:
        return

    params.append(user_id)
    cur.execute(f'UPDATE users SET {", ".join(updates)} WHERE id = ?', params)


def delete_user(user_id):
    """Delete a user."""
    db = get_db()
    cur = db.cursor()
    cur.execute('DELETE FROM users WHERE id = ?', (user_id,))
