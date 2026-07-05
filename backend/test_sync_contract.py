#!/usr/bin/env python3
"""
Contract test for the offline sync op executor (backend/api/sync.py).

The offline client (frontend: offline-api.js queues payloads, sync-manager.js
maps them via toOpType and pushes them through sync_push/sync_commit). Every
handler in _execute_sync_op hand-duplicates an API signature, and the batch
commits atomically -- one mismatched op rolls back the entire offline sync.
This test round-trips the EXACT payload shapes the client produces against a
scratch database so a divergence fails loudly here instead of silently
corrupting user queues.

It also covers the queue_index-maintenance and device-column-preservation fixes
ported from the reference monolith (swapi-apps/swapi_apps/music.py).

Run: python3 backend/test_sync_contract.py   (from the mrepo-web repo root)
"""

import json
import sqlite3
import sys
import tempfile
import unittest
import uuid as uuid_mod
from pathlib import Path

# Import the backend package (modules use relative imports, so they must be
# loaded as backend.api.*). Project root == parent of the backend/ dir.
_repo_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_repo_root))

from backend import db as db_mod  # noqa: E402
from backend.api import queue as queue_mod  # noqa: E402
from backend.api import sync as sync_mod  # noqa: E402
from backend.api import playlists as playlists_mod  # noqa: E402
from backend.api import preferences as preferences_mod  # noqa: E402
from backend.api import playback as playback_mod  # noqa: E402
from backend.api import history as history_mod  # noqa: E402

USER = 'contract-test-user'
DETAILS = {'user_id': USER}

# Modules whose module-level get_db reference must be redirected to the scratch DB
_PATCH_MODULES = [queue_mod, sync_mod, playlists_mod, preferences_mod,
                  playback_mod, history_mod]


def _make_conn(db_path):
    # Mirror db._create_connection settings: autocommit + Row factory
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False,
                           isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


class SyncContractTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name

        # Build the full schema using the real migration, then keep one shared
        # connection for the whole test (calls are sequential).
        self.conn = _make_conn(self.db_path)
        db_mod._run_migrations(self.conn)

        self.songs = [f'song-{i}' for i in range(6)]
        self.conn.executemany(
            "INSERT INTO songs (uuid, file, title) VALUES (?, ?, ?)",
            [(u, f'/music/{u}.flac', u) for u in self.songs])

        for m in _PATCH_MODULES:
            m.get_db = lambda c=self.conn: c

    def tearDown(self):
        self.conn.close()
        Path(self.db_path).unlink(missing_ok=True)

    # ---- helpers -----------------------------------------------------------

    def _push_and_commit(self, ops, expect_success=True):
        """ops: list of (op_type, payload) exactly as sync-manager pushes them."""
        session = f'sess-{uuid_mod.uuid4()}'
        for seq, (op_type, payload) in enumerate(ops):
            r = sync_mod.sync_push(session, seq, op_type, payload, details=DETAILS)
            self.assertTrue(r.get('success'), f'push {op_type} failed: {r}')
        result = sync_mod.sync_commit(session, details=DETAILS)
        if expect_success:
            self.assertTrue(result.get('success'), f'commit failed: {result}')
        return result, session

    def _queue_uuids(self):
        rows = self.conn.execute(
            "SELECT song_uuid, position FROM user_queue WHERE user_id = ? ORDER BY position",
            (USER,)).fetchall()
        # Positions must be contiguous from 0
        self.assertEqual([r['position'] for r in rows], list(range(len(rows))))
        return [r['song_uuid'] for r in rows]

    def _playback_row(self):
        return self.conn.execute(
            "SELECT * FROM user_playback_state WHERE user_id = ?", (USER,)).fetchone()

    def _seed_queue(self, uuids):
        r = queue_mod.queue_add(uuids, None, details=DETAILS)
        self.assertFalse(r.get('error'), f'seed queue_add failed: {r}')

    def _set_index(self, index, device='dev-a', seq=1):
        r = queue_mod.queue_set_index(index, device, seq, details=DETAILS)
        self.assertFalse(r.get('error'), f'set_index failed: {r}')

    # ---- queue op contract (payload shapes from offline-api.js) ------------

    def test_queue_add(self):
        result, _ = self._push_and_commit([
            ('queue.add', {'songUuids': self.songs[:3], 'position': None}),
        ])
        self.assertEqual(result['executed'], 1)
        self.assertEqual(self._queue_uuids(), self.songs[:3])

    def test_queue_remove_verified_payload(self):
        self._seed_queue(self.songs[:5])
        payload = {
            'positions': [1, 3],
            'items': [{'position': 1, 'uuid': self.songs[1]},
                      {'position': 3, 'uuid': self.songs[3]}],
        }
        result, _ = self._push_and_commit([('queue.remove', payload)])
        self.assertEqual(result['executed'], 1)
        self.assertEqual(self._queue_uuids(),
                         [self.songs[0], self.songs[2], self.songs[4]])

    def test_queue_remove_positions_only_fallback(self):
        self._seed_queue(self.songs[:3])
        result, _ = self._push_and_commit([
            ('queue.remove', {'positions': [0]}),
        ])
        self.assertEqual(result['executed'], 1)
        self.assertEqual(self._queue_uuids(), self.songs[1:3])

    def test_queue_remove_diverged_positions_hit_right_songs(self):
        # Client snapshots s0..s4 and removes s1@1 offline; meanwhile another
        # device moved s1 to the end. Raw positions would delete the wrong song
        # -- uuid verification must chase s1 to its new position.
        self._seed_queue(self.songs[:5])
        r = queue_mod.queue_reorder(1, 4, details=DETAILS)  # s1 -> end
        self.assertFalse(r.get('error'), f'reorder failed: {r}')
        self.assertEqual(self._queue_uuids(),
                         [self.songs[0], self.songs[2], self.songs[3],
                          self.songs[4], self.songs[1]])

        payload = {'positions': [1], 'items': [{'position': 1, 'uuid': self.songs[1]}]}
        result, _ = self._push_and_commit([('queue.remove', payload)])
        self.assertEqual(result['executed'], 1)
        self.assertNotIn(self.songs[1], self._queue_uuids())
        self.assertIn(self.songs[2], self._queue_uuids())  # innocent bystander

    def test_queue_remove_missing_uuid_is_skipped_not_fatal(self):
        self._seed_queue(self.songs[:2])
        payload = {'positions': [5], 'items': [{'position': 5, 'uuid': 'gone-uuid'}]}
        result, _ = self._push_and_commit([
            ('queue.remove', payload),
            ('queue.add', {'songUuids': [self.songs[5]], 'position': None}),
        ])
        # The unresolvable removal must not poison the batch
        self.assertEqual(self._queue_uuids(), self.songs[:2] + [self.songs[5]])

    def test_queue_reorder_client_payload(self):
        self._seed_queue(self.songs[:4])
        # offline-api queue.reorder queues {fromPos, toPos, uuid}
        result, _ = self._push_and_commit([
            ('queue.reorder', {'fromPos': 0, 'toPos': 2, 'uuid': self.songs[0]}),
        ])
        self.assertEqual(result['executed'], 1)
        self.assertEqual(self._queue_uuids(),
                         [self.songs[1], self.songs[2], self.songs[0], self.songs[3]])

    def test_queue_reorder_batch_client_payload(self):
        self._seed_queue(self.songs[:5])
        # sync-manager maps queue.reorderBatch with {fromPositions, toPosition, uuids}
        result, _ = self._push_and_commit([
            ('queue.reorderBatch', {
                'fromPositions': [0, 2],
                'toPosition': 5,
                'uuids': [self.songs[0], self.songs[2]],
            }),
        ])
        self.assertEqual(result['executed'], 1)
        self.assertEqual(self._queue_uuids(),
                         [self.songs[1], self.songs[3], self.songs[4],
                          self.songs[0], self.songs[2]])

    def test_queue_set_index_payload(self):
        self._seed_queue(self.songs[:3])
        result, _ = self._push_and_commit([
            ('queue.setIndex', {'index': 2, 'deviceId': 'dev-a', 'seq': 7}),
        ])
        self.assertEqual(result['executed'], 1)
        row = self._playback_row()
        self.assertEqual(row['queue_index'], 2)
        self.assertEqual(row['active_device_id'], 'dev-a')
        self.assertEqual(row['active_device_seq'], 7)

    # ---- queue_index maintenance across mutations --------------------------

    def test_remove_before_current_shifts_index(self):
        # Playing s3 (index 3). Remove s0 and s1 (both before current). The
        # current song must stay s3, now at index 1.
        self._seed_queue(self.songs[:5])
        self._set_index(3)
        r = queue_mod.queue_remove([0, 1], details=DETAILS)
        self.assertFalse(r.get('error'), f'remove failed: {r}')
        row = self._playback_row()
        self.assertEqual(self._queue_uuids()[row['queue_index']], self.songs[3])
        self.assertEqual(row['queue_index'], 1)

    def test_reorder_keeps_current_anchored(self):
        # Playing s0 (index 0). Move it to position 2 -> index follows to 2.
        self._seed_queue(self.songs[:4])
        self._set_index(0)
        r = queue_mod.queue_reorder(0, 2, details=DETAILS)
        self.assertFalse(r.get('error'), f'reorder failed: {r}')
        row = self._playback_row()
        self.assertEqual(self._queue_uuids()[row['queue_index']], self.songs[0])

    def test_reorder_batch_keeps_current_anchored(self):
        # Playing s2. Batch-move [s0, s2] to the end; current follows s2.
        self._seed_queue(self.songs[:5])
        self._set_index(2)
        r = queue_mod.queue_reorder_batch([0, 2], 5, details=DETAILS)
        self.assertFalse(r.get('error'), f'batch reorder failed: {r}')
        row = self._playback_row()
        self.assertEqual(self._queue_uuids()[row['queue_index']], self.songs[2])

    # ---- playlist ops -------------------------------------------------------

    def test_playlists_add_song_payload(self):
        created = playlists_mod.playlists_create('faves', '', False, details=DETAILS)
        self.assertFalse(created.get('error'), f'create failed: {created}')
        pid = created['id']
        result, _ = self._push_and_commit([
            ('playlists.addSong', {'playlistId': pid, 'songUuid': self.songs[0]}),
        ])
        self.assertEqual(result['executed'], 1)

        # Duplicate add is a harmless no-op (INSERT OR IGNORE), not a batch poison
        result2, _ = self._push_and_commit([
            ('playlists.addSong', {'playlistId': pid, 'songUuid': self.songs[0]}),
            ('queue.add', {'songUuids': [self.songs[1]], 'position': None}),
        ])
        self.assertEqual(result2['executed'], 2)
        # Only one row for that song
        count = self.conn.execute(
            "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ? AND song_uuid = ?",
            (pid, self.songs[0])).fetchone()[0]
        self.assertEqual(count, 1)

    def test_temp_playlist_id_resolution_and_map(self):
        result, _ = self._push_and_commit([
            ('playlists.create', {'name': 'road trip', 'description': '',
                                  'isPublic': False, 'tempId': 'pending-42'}),
            ('playlists.addSongsBatch', {'playlistId': 'pending-42',
                                         'songUuids': self.songs[:2]}),
        ])
        self.assertEqual(result['executed'], 2)
        temp_map = result.get('tempIdMap') or {}
        self.assertIn('pending-42', temp_map)

        count = self.conn.execute(
            "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?",
            (temp_map['pending-42'],)).fetchone()[0]
        self.assertEqual(count, 2)

    # ---- preferences: all keys forwarded -----------------------------------

    def test_preferences_set_forwards_ai_keys(self):
        result, _ = self._push_and_commit([
            ('preferences.set', {'radioAlgorithm': 'clap',
                                 'aiSearchMax': 1234,
                                 'aiSearchDiversity': 0.7,
                                 'aiRadioQueueDiversity': 0.4}),
        ])
        self.assertEqual(result['executed'], 1)
        row = self.conn.execute(
            "SELECT radio_algorithm, ai_search_max, ai_search_diversity, ai_radio_queue_diversity "
            "FROM user_preferences WHERE user_id = ?", (USER,)).fetchone()
        self.assertEqual(row['radio_algorithm'], 'clap')
        self.assertEqual(row['ai_search_max'], 1234)
        self.assertAlmostEqual(row['ai_search_diversity'], 0.7)
        self.assertAlmostEqual(row['ai_radio_queue_diversity'], 0.4)

    # ---- commit idempotency -------------------------------------------------

    def test_commit_is_idempotent(self):
        result, session = self._push_and_commit([
            ('queue.add', {'songUuids': self.songs[:3], 'position': None}),
        ])
        self.assertEqual(self._queue_uuids(), self.songs[:3])

        # Client lost the response and retries: re-push + re-commit the same
        # session. The batch must NOT re-apply (no duplicate adds).
        for seq, (op_type, payload) in enumerate(
                [('queue.add', {'songUuids': self.songs[:3], 'position': None})]):
            sync_mod.sync_push(session, seq, op_type, payload, details=DETAILS)
        retry = sync_mod.sync_commit(session, details=DETAILS)
        self.assertTrue(retry.get('alreadyCommitted'))
        self.assertTrue(retry.get('success'))
        self.assertEqual(self._queue_uuids(), self.songs[:3])

        # The re-pushed ops were discarded, not left to leak into a later commit
        leftover = self.conn.execute(
            "SELECT COUNT(*) FROM pending_sync_ops WHERE session_id = ?",
            (session,)).fetchone()[0]
        self.assertEqual(leftover, 0)

    def test_failed_commit_reports_failed_seq(self):
        # An unknown op type is a real (non-harmless) error -> whole batch rolls
        # back and the failing seq is reported so the client can drop it.
        self._seed_queue(self.songs[:2])
        result, _ = self._push_and_commit([
            ('queue.add', {'songUuids': [self.songs[2]], 'position': None}),
            ('bogus.op', {'foo': 'bar'}),
        ], expect_success=False)
        self.assertFalse(result.get('success'))
        self.assertEqual(result.get('failed_seq'), 1)
        # Rolled back: the queue.add at seq 0 must NOT have persisted
        self.assertEqual(self._queue_uuids(), self.songs[:2])

    # ---- playback state column preservation ---------------------------------

    def test_playback_set_state_preserves_device_columns(self):
        self._seed_queue(self.songs[:3])
        queue_mod.queue_set_index(1, 'dev-a', 5, details=DETAILS)
        # Changing volume/play mode must not wipe the active device.
        result, _ = self._push_and_commit([
            ('playback.setState', {'volume': 0.5, 'playMode': 'shuffle'}),
        ])
        self.assertEqual(result['executed'], 1)
        row = self._playback_row()
        self.assertEqual(row['active_device_id'], 'dev-a')
        self.assertEqual(row['active_device_seq'], 5)
        self.assertEqual(row['volume'], 0.5)
        self.assertEqual(row['play_mode'], 'shuffle')
        self.assertEqual(row['queue_index'], 1)

    def test_queue_clear_preserves_device_columns(self):
        self._seed_queue(self.songs[:3])
        queue_mod.queue_set_index(1, 'dev-a', 5, details=DETAILS)
        result, _ = self._push_and_commit([('queue.clear', {})])
        self.assertEqual(result['executed'], 1)
        row = self._playback_row()
        self.assertEqual(row['queue_index'], 0)
        self.assertEqual(row['active_device_id'], 'dev-a')


class QueueReorderDragContractTest(unittest.TestCase):
    """End-to-end contract guard for the drag -> store -> backend reorder chain.

    Regression: a drag that moves an item DOWN BY ONE used to be a silent no-op
    (and every downward move was off-by-one). now-playing.js handleDrop converts
    the drop gap to a target index with (gap > from ? gap - 1 : gap); the store's
    reorderQueue then computed toPos from queue[toIndex - 1] for downward moves,
    applying the post-removal shift a SECOND time. For move-down-by-one that
    collapsed to reorder(p, p), which the backend (correctly) treats as a no-op.

    The fix passes toIndex through directly (toPos = queue[toIndex].position), so
    the REMOTE path lands on the exact same queue as the temp-queue local splice
    (newQueue.splice(fromIndex, 1); splice(toIndex, 0, moved)) -- the behaviour
    the task calls canonical and "works everywhere". These tests replicate the
    (fixed) frontend math and assert the backend agrees with that splice.
    """

    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name
        self.conn = _make_conn(self.db_path)
        db_mod._run_migrations(self.conn)
        self.songs = [f'song-{i}' for i in range(6)]
        self.conn.executemany(
            "INSERT INTO songs (uuid, file, title) VALUES (?, ?, ?)",
            [(u, f'/music/{u}.flac', u) for u in self.songs])
        for m in _PATCH_MODULES:
            m.get_db = lambda c=self.conn: c

    def tearDown(self):
        self.conn.close()
        Path(self.db_path).unlink(missing_ok=True)

    def _seed(self, uuids):
        queue_mod.queue_clear(details=DETAILS)
        r = queue_mod.queue_add(uuids, None, details=DETAILS)
        self.assertFalse(r.get('error'), f'seed failed: {r}')

    def _uuids(self):
        rows = self.conn.execute(
            "SELECT song_uuid, position FROM user_queue WHERE user_id = ? ORDER BY position",
            (USER,)).fetchall()
        self.assertEqual([r['position'] for r in rows], list(range(len(rows))),
                         'positions must stay contiguous from 0')
        return [r['song_uuid'] for r in rows]

    @staticmethod
    def _local_splice(queue, from_index, to_index):
        """temp-queue mode ground truth (player-store.js REMOTE-disabled path)."""
        nq = list(queue)
        moved = nq.pop(from_index)
        nq.insert(to_index, moved)
        return nq

    @staticmethod
    def _store_reorder_args(queue, from_index, to_index):
        """player-store.js reorderQueue REMOTE block, POST-FIX.

        const fromPos = queue[fromIndex].position ?? fromIndex;
        const toPos   = queue[toIndex]?.position ?? toIndex;
        """
        from_pos = queue[from_index]['position']
        to_pos = queue[to_index]['position'] if 0 <= to_index < len(queue) else to_index
        return from_pos, to_pos

    def _drag(self, from_index, to_index):
        """Drive the fixed store math through the real backend queue_reorder and
        assert the result equals the local-splice ground truth."""
        self._seed(self.songs[:5])
        snapshot = [{'uuid': u, 'position': i} for i, u in enumerate(self.songs[:5])]
        expected = [x['uuid'] for x in self._local_splice(snapshot, from_index, to_index)]
        from_pos, to_pos = self._store_reorder_args(snapshot, from_index, to_index)
        r = queue_mod.queue_reorder(from_pos, to_pos, details=DETAILS)
        self.assertFalse(r.get('error'), f'reorder failed: {r}')
        self.assertEqual(self._uuids(), expected,
                         f'drag {from_index}->{to_index} sent reorder({from_pos},{to_pos})')

    def test_move_down_by_one_actually_moves(self):
        # The exact bug: item at index 1 dropped just below the following item.
        # handleDrop: gap = 3 -> to = 2. Pre-fix this sent reorder(1, 1) = no-op.
        self._drag(1, 2)

    def test_move_up_by_one(self):
        self._drag(3, 2)

    def test_move_down_by_two(self):
        # Pre-fix this landed one slot short (off-by-one), not a no-op.
        self._drag(0, 2)

    def test_move_up_by_two(self):
        self._drag(4, 2)

    def test_move_down_to_end(self):
        self._drag(0, 4)

    def test_move_up_to_front(self):
        self._drag(4, 0)

    def test_all_index_pairs_match_local_splice(self):
        # Exhaustive: every REMOTE reorder must match the temp-queue splice.
        for f in range(5):
            for t in range(5):
                if f == t:
                    continue  # store early-returns on fromIndex === toIndex
                with self.subTest(frm=f, to=t):
                    self._drag(f, t)

    def test_batch_move_down_by_one_unaffected(self):
        # Batch path passes the raw drop gap (handleDrop line 990: target = gap,
        # NOT gap - 1) and the backend applies the single adjustment, so it was
        # never double-shifted. Guard that it stays correct.
        self._seed(self.songs[:5])
        # Drag item at index 1 below the following item: gap = 3 (batch target).
        r = queue_mod.queue_reorder_batch([1], 3, details=DETAILS)
        self.assertFalse(r.get('error'), f'batch reorder failed: {r}')
        self.assertEqual(
            self._uuids(),
            [self.songs[0], self.songs[2], self.songs[1], self.songs[3], self.songs[4]])


class RadioDuplicatesContractTest(unittest.TestCase):
    """Radio start must not crash on duplicate playlist/queue entries.

    Playlists (PK (playlist_id, position)) and the queue support the same song
    appearing more than once, but sca_song_pool/sca_original_seeds are keyed on
    (user_id, song_uuid). sca_start_from_playlist/queue dedupe order-preserving
    before the pool copy - the plain INSERTs used to raise IntegrityError and
    radio failed to start entirely. The private backend mirrors this contract.
    """

    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name
        self.conn = _make_conn(self.db_path)
        db_mod._run_migrations(self.conn)
        self.songs = [f'song-{i}' for i in range(4)]
        self.conn.executemany(
            "INSERT INTO songs (uuid, file, title) VALUES (?, ?, ?)",
            [(u, f'/music/{u}.flac', u) for u in self.songs])
        from backend.api import radio as radio_mod
        self.radio = radio_mod
        for m in _PATCH_MODULES + [radio_mod]:
            m.get_db = lambda c=self.conn: c

    def tearDown(self):
        self.conn.close()
        Path(self.db_path).unlink(missing_ok=True)

    def _pool_uuids(self):
        rows = self.conn.execute(
            "SELECT song_uuid FROM sca_song_pool WHERE user_id = ?", (USER,)).fetchall()
        return sorted(r['song_uuid'] for r in rows)

    def test_start_from_playlist_with_duplicates(self):
        created = playlists_mod.playlists_create('dups', details=DETAILS)
        pid = created['id']
        # A playlist with song-0 twice (positions are the PK, uuids repeat)
        entries = [self.songs[0], self.songs[1], self.songs[0], self.songs[2]]
        self.conn.executemany(
            "INSERT INTO playlist_songs (playlist_id, song_uuid, position) VALUES (?, ?, ?)",
            [(pid, u, i) for i, u in enumerate(entries)])

        r = self.radio.sca_start_from_playlist(pid, details=DETAILS)
        self.assertTrue(r.get('success'), f'radio must start despite duplicates: {r}')
        self.assertEqual(r['poolSize'], 3, 'pool size is the DISTINCT song count')
        self.assertEqual(self._pool_uuids(), sorted(entries[:2] + [self.songs[2]]))

    def test_start_from_queue_with_duplicates(self):
        queue_mod.queue_add([self.songs[0], self.songs[1], self.songs[0]], None, details=DETAILS)
        r = self.radio.sca_start_from_queue(details=DETAILS)
        self.assertTrue(r.get('success'), f'radio must start despite duplicates: {r}')
        self.assertEqual(self._pool_uuids(), sorted([self.songs[0], self.songs[1]]))


class ShareTokenContractTest(unittest.TestCase):
    """Least-privilege contract for share links (playlists_get_songs_by_token).

    The unguessable share token is the capability: it grants anonymous read
    access to exactly the playlist it was minted for, and nothing else. The
    user-scoped playlists_get_songs stays require='user' (enforced at the
    dispatch layer; here we pin the shapes and the token semantics). The
    private backend (swapi_apps/music.py) mirrors this contract.
    """

    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self._tmp.close()
        self.db_path = self._tmp.name
        self.conn = _make_conn(self.db_path)
        db_mod._run_migrations(self.conn)
        self.songs = [f'song-{i}' for i in range(4)]
        self.conn.executemany(
            "INSERT INTO songs (uuid, file, title) VALUES (?, ?, ?)",
            [(u, f'/music/{u}.flac', u) for u in self.songs])
        for m in _PATCH_MODULES:
            m.get_db = lambda c=self.conn: c
        created = playlists_mod.playlists_create('shared', details=DETAILS)
        self.playlist_id = created['id']
        playlists_mod.playlists_add_songs(self.playlist_id, self.songs, details=DETAILS)
        self.token = playlists_mod.playlists_share(self.playlist_id, details=DETAILS)['share_token']

    def tearDown(self):
        self.conn.close()
        Path(self.db_path).unlink(missing_ok=True)

    def test_valid_token_returns_all_songs_without_user_context(self):
        # No details/user argument at all - the token is the only credential.
        r = playlists_mod.playlists_get_songs_by_token(self.token)
        self.assertEqual([i['uuid'] for i in r['items']], self.songs)
        self.assertEqual(r['totalCount'], len(self.songs))
        self.assertFalse(r['hasMore'])

    def test_token_pagination_matches_get_songs_shape(self):
        r1 = playlists_mod.playlists_get_songs_by_token(self.token, limit=3)
        self.assertEqual(len(r1['items']), 3)
        self.assertTrue(r1['hasMore'])
        r2 = playlists_mod.playlists_get_songs_by_token(self.token, cursor=r1['nextCursor'])
        self.assertEqual([i['uuid'] for i in r2['items']], self.songs[3:])
        self.assertEqual(set(r1.keys()), set(r2.keys()))
        # Same envelope keys as the authenticated endpoint.
        auth = playlists_mod.playlists_get_songs(self.playlist_id, details=DETAILS)
        self.assertEqual(set(r1.keys()), set(auth.keys()))

    def test_unknown_and_empty_tokens_are_generic_not_found(self):
        with self.assertRaises(ValueError):
            playlists_mod.playlists_get_songs_by_token('no-such-token')
        with self.assertRaises(ValueError):
            playlists_mod.playlists_get_songs_by_token('')
        with self.assertRaises(ValueError):
            playlists_mod.playlists_get_songs_by_token(None)

    def test_unshared_playlist_is_unreachable_by_token(self):
        # A second, unshared playlist must not be reachable via any token -
        # including the first playlist's (token maps to exactly one playlist).
        other = playlists_mod.playlists_create('unshared', details=DETAILS)
        playlists_mod.playlists_add_songs(other['id'], self.songs[:1], details=DETAILS)
        r = playlists_mod.playlists_get_songs_by_token(self.token)
        self.assertEqual(r['totalCount'], len(self.songs), 'token must resolve its own playlist only')

    def test_by_token_metadata_has_no_owner_identity(self):
        meta = playlists_mod.playlists_by_token(self.token)
        self.assertNotIn('user_id', meta)
        self.assertEqual(meta['name'], 'shared')
        self.assertEqual(meta['song_count'], len(self.songs))


if __name__ == '__main__':
    unittest.main(verbosity=2)
