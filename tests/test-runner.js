#!/usr/bin/env node

/**
 * mrepo E2E Test Runner
 *
 * Usage:
 *   node test-runner.js              # Run all tests with full output
 *   node test-runner.js --only-errors # Only show output from failing tests
 *   node test-runner.js auth.test.js  # Run a specific test file
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parse command line args
const args = process.argv.slice(2);
const onlyErrors = args.includes('--only-errors');
const specificFiles = args.filter(arg => arg.endsWith('.test.js'));

// Find all test files
const testDir = __dirname;
let testFiles;

if (specificFiles.length > 0) {
    // Run specific test files
    testFiles = specificFiles.filter(file => {
        const fullPath = path.join(testDir, file);
        return fs.existsSync(fullPath);
    });
    if (testFiles.length === 0) {
        console.error('No valid test files found');
        process.exit(1);
    }
} else {
    // Run all test files
    testFiles = fs.readdirSync(testDir)
        .filter(file => file.endsWith('.test.js'))
        .sort();
}

console.log('='.repeat(70));
console.log('mrepo E2E Test Suite');
console.log('='.repeat(70));
console.log(`Found ${testFiles.length} test file(s)`);
if (onlyErrors) {
    console.log('Mode: --only-errors (suppressing output from passing tests)');
}
console.log();

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(testFile) {
    return new Promise((resolve) => {
        if (!onlyErrors) {
            console.log(`\n📦 Running: ${testFile}`);
            console.log('-'.repeat(70));
        }

        const stdioOption = onlyErrors ? 'pipe' : 'inherit';
        const child = spawn('node', [path.join(testDir, testFile)], {
            stdio: stdioOption,
            env: { ...process.env, FORCE_COLOR: '1' }
        });

        let output = '';
        if (onlyErrors) {
            child.stdout.on('data', (data) => {
                output += data.toString();
            });
            child.stderr.on('data', (data) => {
                output += data.toString();
            });
        }

        child.on('close', (code) => {
            if (code === 0) {
                if (!onlyErrors) {
                    console.log(`✅ ${testFile} passed\n`);
                } else {
                    process.stdout.write('.');
                }
                resolve({ passed: true, file: testFile, output });
            } else {
                if (onlyErrors) {
                    console.log(`\n\n📦 ${testFile}`);
                    console.log('-'.repeat(70));
                    console.log(output);
                }
                console.log(`❌ ${testFile} failed with code ${code}\n`);
                resolve({ passed: false, file: testFile, output });
            }
        });
    });
}

async function runAllTests() {
    let results;

    if (onlyErrors && testFiles.length > 1) {
        // Run tests in parallel for faster execution
        console.log('Running tests in parallel...\n');
        results = await Promise.all(testFiles.map(testFile => runTest(testFile)));
    } else {
        // Run tests sequentially for readable output
        results = [];
        for (const testFile of testFiles) {
            const result = await runTest(testFile);
            results.push(result);
        }
    }

    // Count results
    for (const result of results) {
        totalTests++;
        if (result.passed) {
            passedTests++;
        } else {
            failedTests++;
        }
    }

    if (onlyErrors) {
        console.log('\n');
    }

    console.log('='.repeat(70));
    console.log('Test Summary');
    console.log('='.repeat(70));
    console.log(`Total: ${totalTests}`);
    console.log(`Passed: ${passedTests} ✅`);
    console.log(`Failed: ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
    console.log('='.repeat(70));

    if (failedTests > 0) {
        console.log('\nFailed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  ❌ ${r.file}`);
        });
        process.exit(1);
    } else {
        console.log('\n🎉 All tests passed!');
        process.exit(0);
    }
}

runAllTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
