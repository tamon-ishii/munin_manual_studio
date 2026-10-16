# Spec Delta

## Purpose

自然文の撮影・注釈指示を実際のアプリ操作とスクリーンショットに変換し、原本と注釈と撮影手順を保存する。アプリ登録から候補確認までをつなぎ、同じ手順で後日再撮影できるようにする。

## ADDED Requirements

### Requirement: Application registration from instruction
The system SHALL propose a target application from the instruction, reuse an existing registration when possible, and allow checking or correcting the executable and arguments before registration and launch.

#### Scenario: Target is not registered
- **WHEN** the instruction names an unregistered app
- **THEN** a registration form proposes the app and lets the user select a real executable before launching

### Requirement: Reviewable real screenshot recipe
The system SHALL derive navigation from observed accessibility elements, let the user review the recipe, and capture the actual selected app window. The recipe MUST reject unsupported operations and fabricated targets.

#### Scenario: Requested control cannot be observed
- **WHEN** a proposed action refers to an unobserved control
- **THEN** the action is rejected and the user can use operation recording instead

### Requirement: Reproducible annotations and adoption
The system SHALL create annotation candidates using real captured element bounds, preserve the raw screenshot and replay recipe, and offer comparison and adoption through the resource library. Subsequent recapture SHALL reuse the stored recipe and annotations without requiring AI.

#### Scenario: Number toolbar buttons
- **WHEN** the user requests numbered toolbar buttons and the buttons are present in captured metadata
- **THEN** a MarkIts candidate places numbered badges at those real elements

#### Scenario: Annotation fails after capture
- **WHEN** annotation cannot identify the requested elements
- **THEN** the captured original and replay recipe remain available for manual annotation
