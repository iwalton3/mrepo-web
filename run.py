#!/usr/bin/env python3
"""Run the mrepo development server."""

import argparse

from backend.app import create_app

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run mrepo development server')
    parser.add_argument('-p', '--port', type=int, default=8080, help='Port to listen on (default: 8080)')
    parser.add_argument('--host', default='0.0.0.0', help='Host to bind to (default: 0.0.0.0)')
    parser.add_argument('--no-debug', action='store_true', help='Disable debug mode')
    args = parser.parse_args()

    app = create_app()
    app.run(debug=not args.no_debug, host=args.host, port=args.port)
