# Requirements Document

## Introduction

This feature enhances TypeKro's deployment progress monitoring by integrating Kubernetes events streaming and detailed debug logging during resource deployment and status polling. Currently, users only receive basic progress updates during deployment, making it difficult to diagnose issues when resources fail to become ready. This enhancement will provide real-time visibility into Kubernetes events related to deployed resources and detailed debug information about resource status polling.

## Requirements

### Requirement 1: Real-time Kubernetes Events Streaming

**User Story:** As a developer deploying resources with TypeKro, I want to see relevant Kubernetes events in real-time during deployment so that I can quickly identify and troubleshoot issues.

#### Acceptance Criteria

1. WHEN deploying resources in direct mode THEN the system SHALL stream Kubernetes events related to the deployed resources during the deployment process
2. WHEN deploying resources in Kro mode THEN the system SHALL stream events for both the ResourceGraphDefinition and the underlying resources it creates
3. WHEN a resource fails to become ready THEN the system SHALL display relevant Warning and Error events that explain the failure
4. WHEN multiple resources are deployed in parallel THEN events SHALL be properly attributed to the correct resource and displayed with clear resource identification
5. WHEN events are streamed THEN they SHALL include timestamp, event type, reason, message, and source resource information
6. WHEN the deployment completes successfully THEN event streaming SHALL stop automatically
7. WHEN the deployment fails or times out THEN event streaming SHALL continue until the timeout period expires to capture late-arriving diagnostic events

### Requirement 2: Enhanced Debug Logging for Status Polling

**User Story:** As a developer troubleshooting deployment issues, I want detailed debug logs showing the current status of resources being polled so that I can understand why resources are not becoming ready.

#### Acceptance Criteria

1. WHEN resources are being polled for readiness THEN the system SHALL log the current status fields of each resource at debug level
2. WHEN a resource is not ready THEN the system SHALL log the specific conditions or status fields that indicate why it's not ready
3. WHEN using custom readiness evaluators THEN the system SHALL log the evaluation result and any relevant status data used in the evaluation
4. WHEN polling times out THEN the system SHALL log the final status of the resource to help diagnose the timeout cause
5. WHEN multiple resources are being polled THEN debug logs SHALL clearly identify which resource each log entry refers to
6. WHEN status polling encounters API errors THEN the system SHALL log the error details while continuing to poll other resources
7. WHEN resources have complex nested status structures THEN the system SHALL log relevant nested fields in a readable format

### Requirement 3: Event Filtering and Relevance

**User Story:** As a developer using TypeKro, I want to see only events that are relevant to my deployment so that I'm not overwhelmed with cluster-wide noise.

#### Acceptance Criteria

1. WHEN streaming events THEN the system SHALL filter events to only show those related to resources in the current deployment
2. WHEN filtering events THEN the system SHALL include events for resources created by the deployment, including child resources (e.g., ReplicaSets created by Deployments)
3. WHEN a resource creates other resources THEN the system SHALL automatically discover and monitor events for those child resources
4. WHEN events are older than the deployment start time THEN they SHALL be excluded unless they provide relevant context for current issues
5. WHEN events have severity levels THEN Warning and Error events SHALL always be shown, while Normal events SHALL be shown selectively based on relevance
6. WHEN the same event is repeated multiple times THEN the system SHALL deduplicate or summarize repeated events to avoid spam

### Requirement 4: Progress Callback Integration

**User Story:** As a developer integrating TypeKro into my tooling, I want events and debug information to be available through the existing progress callback system so that I can display them in my UI.

#### Acceptance Criteria

1. WHEN events are streamed THEN they SHALL be delivered through the existing progressCallback mechanism in DeploymentOptions
2. WHEN debug status information is available THEN it SHALL be included in progress events with appropriate event types
3. WHEN progress callbacks are not provided THEN events and debug information SHALL still be logged to the console at appropriate log levels
4. WHEN events contain structured data THEN they SHALL be properly formatted for both callback delivery and console logging
5. WHEN integrating with existing progress events THEN the new event types SHALL not break existing progress callback implementations
6. WHEN events are delivered via callbacks THEN they SHALL include sufficient metadata for UIs to categorize and display them appropriately

### Requirement 5: Performance and Resource Efficiency

**User Story:** As a developer deploying large resource graphs, I want event streaming and debug logging to have minimal performance impact so that deployments remain fast and efficient.

#### Acceptance Criteria

1. WHEN streaming events THEN the system SHALL use efficient Kubernetes watch APIs rather than polling for events
2. WHEN multiple resources are deployed THEN event watching SHALL be optimized to minimize API calls and resource usage
3. WHEN deployments complete THEN event watchers SHALL be properly cleaned up to prevent resource leaks
4. WHEN debug logging is disabled THEN status polling SHALL not incur additional overhead for log preparation
5. WHEN event streaming encounters API errors THEN it SHALL implement appropriate backoff and retry logic without blocking deployment progress
6. WHEN large numbers of events are generated THEN the system SHALL implement rate limiting or batching to prevent overwhelming the progress callback system

### Requirement 6: Configuration and Control

**User Story:** As a developer using TypeKro in different environments, I want to control the level of event streaming and debug logging so that I can adjust verbosity based on my needs.

#### Acceptance Criteria

1. WHEN deploying resources THEN users SHALL be able to enable or disable event streaming via deployment options
2. WHEN configuring logging THEN users SHALL be able to set debug log levels for status polling independently from other logging
3. WHEN event streaming is enabled THEN users SHALL be able to configure event types to include (Normal, Warning, Error)
4. WHEN using progress callbacks THEN users SHALL be able to filter which event types are delivered to callbacks vs. logged to console
5. WHEN debugging specific issues THEN users SHALL be able to enable verbose mode that includes additional diagnostic information
6. WHEN running in CI/CD environments THEN the system SHALL provide sensible defaults that balance informativeness with log volume