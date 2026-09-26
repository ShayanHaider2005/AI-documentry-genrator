'use strict';

/**
 * sample.js — Generates a synthetic demo document.
 *
 * The pipeline used to default to a checked-in `server/sample.pdf`. That file was
 * a real lecture deck, which meant personal/academic content sat in a public
 * repository. It is now generated on demand instead: a fresh clone can run
 * `npm run pipeline` with no setup, and nothing private is ever committed.
 *
 * Exports: ensureSamplePdf(targetPath) → string (the path used)
 */

const fs = require('fs');
const path = require('path');
const { createFallbackPdf } = require('./parsePdf');

const DEMO_DOCUMENT = `Introduction to Software Quality Engineering

Quality Concepts and Definitions
Correctness and its measures
Reliability and fault tolerance
Maintainability and technical debt
Performance and efficiency

Quality Models and Standards
ISO 25010 quality model
Product quality characteristics
ISO 9001 process based quality
CMMI maturity levels

Software Quality Assurance Planning
Quality assurance plan structure
Verification and validation
Design reviews and architecture audits
Configuration and change management

Testing Fundamentals and Static Analysis
Static testing and code inspection
Peer review practices
Static analysis tools
Defect detection before execution

Dynamic Testing and Boundary Conditions
Dynamic testing objectives
Boundary value analysis
Stress and load conditions
Concurrency and race conditions

Test Levels and Specification Based Testing
Unit testing foundations
Integration testing strategies
System and acceptance testing
Specification based test design
Test coverage measurement

Measurement and Reliability Models
Defect density metrics
Mean time to failure
Reliability growth curves
Statistical process control
Quantitative quality targets

Risk Based Testing Strategy
Technical risk assessment
User impact prioritisation
Operational uncertainty
Release readiness criteria

Continuous Integration and Quality
Continuous integration pipelines
Automated regression suites
Build verification
Configuration management
Quality dashboards and telemetry

Importance of Software Quality
Cost of defect discovery
Maintenance and evolution cost
User trust and adoption
Long term product sustainability

Quality Attributes and Measurement
Performance efficiency characteristics
Compatibility and usability
Security and resilience
Maintainability and analysability
Measurement program design`;

/**
 * Write the demo PDF if it is missing, and return the path either way.
 * Never overwrites an existing file, so a user-supplied document is safe.
 */
function ensureSamplePdf(targetPath) {
	const destination = targetPath || path.join(__dirname, 'sample.pdf');

	if (fs.existsSync(destination)) {
		return destination;
	}

	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.writeFileSync(destination, createFallbackPdf(DEMO_DOCUMENT));
	console.log(`[SAMPLE] Generated a demo document at ${destination}`);
	console.log(
		'[SAMPLE] Replace it with your own PDF, or pass one: node server/pipeline.js my.pdf',
	);

	return destination;
}

module.exports = { ensureSamplePdf, DEMO_DOCUMENT };
