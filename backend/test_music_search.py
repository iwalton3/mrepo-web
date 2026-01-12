#!/usr/bin/env python3
"""Unit tests for music_search.py parser, particularly compound AI search."""

import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

from music_search import parse_query, extract_ai_info, build_sql


def test_simple_ai_query():
    """Test simple AI query parsing."""
    ast = parse_query("ai:happy electronic")
    ai_info = extract_ai_info(ast)

    assert ai_info.text_prompts == ["happy electronic"], f"Expected ['happy electronic'], got {ai_info.text_prompts}"
    assert ai_info.positive_texts == ["happy electronic"]
    assert ai_info.negative_texts == []
    assert not ai_info.has_compound_terms
    print("  ✅ Simple AI query")


def test_compound_with_plus():
    """Test AI query with + (AND) operator."""
    ast = parse_query("ai:happy +ai:piano")
    ai_info = extract_ai_info(ast)

    assert "happy" in ai_info.positive_texts
    assert "piano" in ai_info.positive_texts
    assert len(ai_info.negative_texts) == 0
    # Note: has_compound_terms only true if there are negations
    print("  ✅ Compound with + operator")


def test_compound_with_minus():
    """Test AI query with - (NOT) operator."""
    ast = parse_query("ai:dreamy -ai:electronic")
    ai_info = extract_ai_info(ast)

    assert "dreamy" in ai_info.positive_texts
    assert "electronic" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ Compound with - operator")


def test_multiple_negations():
    """Test AI query with multiple negations."""
    ast = parse_query("ai:japanese pop -ai:rock -ai:metal")
    ai_info = extract_ai_info(ast)

    assert "japanese pop" in ai_info.positive_texts
    assert "rock" in ai_info.negative_texts
    assert "metal" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ Multiple negations")


def test_mixed_plus_minus():
    """Test AI query with both + and - operators."""
    ast = parse_query("ai:dreamy +ai:piano -ai:electronic -ai:drums")
    ai_info = extract_ai_info(ast)

    assert "dreamy" in ai_info.positive_texts
    assert "piano" in ai_info.positive_texts
    assert "electronic" in ai_info.negative_texts
    assert "drums" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ Mixed + and - operators")


def test_hyphenated_term_preserved():
    """Test that hyphenated terms like j-pop are not split."""
    ast = parse_query("ai:j-pop happy")
    ai_info = extract_ai_info(ast)

    # j-pop should be preserved as a single term
    assert len(ai_info.positive_texts) == 1
    assert "j-pop happy" in ai_info.positive_texts
    assert len(ai_info.negative_texts) == 0
    assert not ai_info.has_compound_terms
    print("  ✅ Hyphenated terms preserved")


def test_hyphenated_term_with_negation():
    """Test hyphenated terms combined with negation."""
    ast = parse_query("ai:j-pop -ai:rock")
    ai_info = extract_ai_info(ast)

    # j-pop should be preserved, -ai:rock should be negation
    assert "j-pop" in ai_info.positive_texts
    assert "rock" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ Hyphenated terms with negation")


def test_lofi_term():
    """Test lo-fi term is preserved."""
    ast = parse_query("ai:lo-fi chill beats")
    ai_info = extract_ai_info(ast)

    assert "lo-fi chill beats" in ai_info.positive_texts
    assert not ai_info.has_compound_terms
    print("  ✅ lo-fi term preserved")


def test_with_category_filter():
    """Test compound AI search with category filter."""
    ast = parse_query("c:youtube AND ai:happy +ai:summer -ai:sad")
    ai_info = extract_ai_info(ast)

    assert "happy" in ai_info.positive_texts
    assert "summer" in ai_info.positive_texts
    assert "sad" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ With category filter")


def test_traditional_and_no_compound():
    """Test traditional AND doesn't trigger compound (no negation)."""
    ast = parse_query("ai:happy AND ai:electronic")
    ai_info = extract_ai_info(ast)

    # Both should be positive texts
    assert len(ai_info.negative_texts) == 0
    assert not ai_info.has_compound_terms
    print("  ✅ Traditional AND (no compound)")


def test_traditional_not():
    """Test traditional NOT syntax triggers compound."""
    ast = parse_query("ai:happy NOT ai:sad")
    ai_info = extract_ai_info(ast)

    assert "happy" in ai_info.positive_texts
    assert "sad" in ai_info.negative_texts
    assert ai_info.has_compound_terms
    print("  ✅ Traditional NOT triggers compound")


def test_sql_build_basic():
    """Test basic SQL building still works."""
    ast = parse_query("a:Beatles")
    sql, params = build_sql(ast)

    assert "artist like" in sql.lower()
    assert params[0] == "%Beatles%"
    print("  ✅ Basic SQL build")


def test_sql_case_insensitive():
    """Test that LIKE queries have COLLATE NOCASE."""
    ast = parse_query("a:test")
    sql, params = build_sql(ast)

    assert "COLLATE NOCASE" in sql
    print("  ✅ Case insensitive SQL")


def main():
    print("=" * 60)
    print("MUSIC SEARCH PARSER TESTS")
    print("=" * 60)

    tests = [
        test_simple_ai_query,
        test_compound_with_plus,
        test_compound_with_minus,
        test_multiple_negations,
        test_mixed_plus_minus,
        test_hyphenated_term_preserved,
        test_hyphenated_term_with_negation,
        test_lofi_term,
        test_with_category_filter,
        test_traditional_and_no_compound,
        test_traditional_not,
        test_sql_build_basic,
        test_sql_case_insensitive,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  ❌ {test.__name__}: {e}")
            failed += 1

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
