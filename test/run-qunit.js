/*
 * Headless CI runner for the jQuery QUnit suite (test/index.html).
 *
 * Serves the repository root with PHP's built-in web server (the ajax tests
 * rely on test/data/*.php), loads the suite in headless Chrome via puppeteer,
 * prints one line per test plus every failed assertion, then a final report:
 * the skipped tests with their reasons and the passed/failed test and
 * assertion counts. Exits non-zero on any failure.
 *
 * Usage: node test/run-qunit.js [query-string]   e.g. "dev"
 */
"use strict";

const { spawn } = require( "child_process" );
const path = require( "path" );
const puppeteer = require( "puppeteer" );

const root = path.resolve( __dirname, ".." );
const port = process.env.QUNIT_PORT || "8123";
const query = process.argv[ 2 ] ? "?" + process.argv[ 2 ] : "";
const url = "http://127.0.0.1:" + port + "/test/index.html" + query;

// Tests that cannot pass in a current headless Chrome for reasons of browser
// policy/layout behaviour that postdates this release (not jQuery defects).
// They are not registered; the final report lists each one with its reason.
const EXCLUDED = {
	"Check CSP (https://developer.mozilla.org/en-US/docs/Security/CSP) restrictions":
		"current Chrome reports the setAttribute(\"on\" + event) feature probe in " +
		"src/event/support.js as an inline-handler CSP violation, so csp-log.php is hit",
	"#14379 - jQuery.ajax() on unload":
		"Chrome >= 80 forbids synchronous XHR during page dismissal (unload), " +
		"so the request fails by browser policy",
	"fractions (see #7730 and #7885)":
		"Chrome LayoutNG snaps layout positions to 1/64 px, so offset().top reads " +
		"999.984375 instead of 1000"
};

function sleep( ms ) {
	return new Promise( ( r ) => setTimeout( r, ms ) );
}

( async function() {
	// Several workers: test/data/core/dont_return.php sleeps 30s and would
	// otherwise block every other request of the single-threaded server.
	const php = spawn( "php", [ "-S", "127.0.0.1:" + port, "-t", root ], {
		stdio: [ "ignore", "ignore", "ignore" ],
		env: Object.assign( {}, process.env, { PHP_CLI_SERVER_WORKERS: "8" } )
	} );
	await sleep( 1500 );

	const browser = await puppeteer.launch( {
		headless: true,
		args: [
			"--no-sandbox", "--disable-setuid-sandbox",

			// This suite (2014) relies on the "unload" event, which current Chrome
			// no longer dispatches by default
			"--disable-features=DeprecateUnload,DeprecateUnloadByAllowList"
		]
	} );

	let finished;
	const done = new Promise( ( r ) => { finished = r; } );
	const results = [];
	const skipped = [];

	try {
		const page = await browser.newPage();
		await page.exposeFunction( "__qunitTestDone", ( t ) => {
			results.push( t );
			const status = t.failed ? "FAIL" : "PASS";
			console.log( status + ": " + t.module + " :: " + t.name +
				" (" + t.passed + "/" + t.total + " assertions)" );
			t.failures.forEach( ( f ) => console.log( "    " + f ) );
		} );
		await page.exposeFunction( "__qunitSkip", ( s ) => skipped.push( s ) );
		await page.exposeFunction( "__qunitDone", ( d ) => finished( d ) );
		await page.evaluateOnNewDocument( function( excluded ) {
			if ( window !== window.top ) {
				return;
			}
			let q;
			let failures = [];
			Object.defineProperty( window, "QUnit", {
				configurable: true,
				get: function() { return q; },
				set: function( v ) {
					q = v;
					if ( !v || v.__hooked ) {
						return;
					}
					v.__hooked = true;

					const origTest = window.test;
					window.test = v.test = function( title ) {
						if ( Object.prototype.hasOwnProperty.call( excluded, title ) ) {
							window.__qunitSkip( {
								module: v.config.currentModule || "",
								name: title,
								reason: excluded[ title ]
							} );
							return;
						}
						return origTest.apply( this, arguments );
					};

					v.log( function( d ) {
						if ( !d.result ) {
							failures.push( ( d.message || "" ) +
								( "expected" in d ? " | expected: " + String( d.expected ) +
									" | actual: " + String( d.actual ) : "" ) +
								( d.source ? " | " + String( d.source ).split( "\n" )[ 0 ] : "" ) );
						}
					} );
					v.testDone( function( d ) {
						window.__qunitTestDone( {
							module: d.module, name: d.name, failed: d.failed,
							passed: d.passed, total: d.total, failures: failures
						} );
						failures = [];
					} );
					v.done( function( d ) {
						window.__qunitDone( {
							failed: d.failed, passed: d.passed, total: d.total, runtime: d.runtime
						} );
					} );
				}
			} );
		}, EXCLUDED );
		page.on( "pageerror", ( e ) => console.log( "PAGE ERROR: " + e.message ) );

		console.log( "Running " + url );
		await page.goto( url, { waitUntil: "load", timeout: 120000 } );

		const timeout = sleep( 30 * 60 * 1000 ).then( () => null );
		const d = await Promise.race( [ done, timeout ] );
		if ( !d ) {
			throw new Error( "QUnit suite did not finish within 30 minutes" );
		}

		const failedTests = results.filter( ( t ) => t.failed );
		console.log( "" );
		console.log( "==== jQuery QUnit report (" + url + ") ====" );
		skipped.forEach( ( s ) => console.log( "SKIPPED: " + s.module + " :: " + s.name +
			" -- reason: " + s.reason ) );
		failedTests.forEach( ( t ) => console.log( "FAILED TEST: " + t.module + " :: " + t.name ) );
		console.log( "Tests: " + results.length + " run, " +
			( results.length - failedTests.length ) + " passed, " + failedTests.length +
			" failed, " + skipped.length + " skipped" );
		console.log( "Assertions: " + d.total + " total, " + d.passed + " passed, " +
			d.failed + " failed (" + d.runtime + " ms)" );
		process.exitCode = d.failed || failedTests.length ? 1 : 0;
	} catch ( e ) {
		console.log( "RUNNER ERROR: " + ( e && e.stack || e ) );
		process.exitCode = 2;
	} finally {
		await browser.close();
		php.kill();
		process.exit( process.exitCode );
	}
} )();
