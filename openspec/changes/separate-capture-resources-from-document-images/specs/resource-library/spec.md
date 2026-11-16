# Spec Delta

## MODIFIED Requirements

### Requirement: Browse and filter project image resources
Manual Studio SHALL expose project-owned capture resources in a 撮影リソース一覧 Dock without requiring a selected document or AI connection. It SHALL deduplicate resource IDs, support search and saved-document usage filters, show missing resources, and load thumbnails on demand. Ordinary project images and unrelated generated images SHALL remain available through their existing browsers.

#### Scenario: Filter unused generated images
- **WHEN** the user selects generated images and unused resources in an existing image browser
- **THEN** only generated images without saved Markdown usage are displayed and they are not registered as capture resources implicitly.

#### Scenario: View a missing managed image
- **WHEN** metadata references a missing output
- **THEN** the resource remains listed with its missing state.

#### Scenario: Restore the capture Dock
- **WHEN** the user opens, closes, moves and reopens the capture resource Dock or restarts Studio
- **THEN** its visibility and layout can be restored without duplicate panels or loss of registered resources.

### Requirement: Drag resource images into documents
Resource thumbnails SHALL provide project-bound drag data for rich text and source editors. Capture-resource drops SHALL generate or reuse an ID-only document image and insert its relative reference, never the private source. Insertion SHALL participate in undo and save. Drops across projects or without an editable document SHALL be rejected.

#### Scenario: Drop a managed screenshot
- **WHEN** the user drops a capture resource into an editable manuscript
- **THEN** a relative reference to its generated document image is inserted and its embedded ID resolves the capture resource
- **AND** undo restores the previous manuscript.

## ADDED Requirements

### Requirement: Generate document images from capture resources
The Dock SHALL offer image generation and explicit insertion for a selected capture resource. Repeated insertion of the same derived image SHALL reuse its output; independent annotation or crop variants SHALL have separate outputs linked to the same resource. Registration SHALL survive cancelled insertion.

#### Scenario: Generate before selecting a document
- **WHEN** a user generates a document image without a manuscript selected
- **THEN** the image is saved and available for later insertion without creating a document.

#### Scenario: Insert in two manuscripts
- **WHEN** the same derived image is inserted in two manuscripts
- **THEN** both relative references resolve to the same output without duplicating the capture.

#### Scenario: Cancel insertion or switch document
- **WHEN** insertion is cancelled or its original document is superseded
- **THEN** no insertion is applied to another document and the resource and generated image remain available.

### Requirement: Prevent private capture images from entering document output
Studio-controlled image insertion and replacement SHALL route metadata-bearing capture images through private registration and document-image generation. Publishing managed capture images SHALL include only ID-only document renders and exclude private source files and recordings. Existing Markdown SHALL remain readable without silent conversion.

#### Scenario: Insert from the file tree
- **WHEN** a user inserts or drops a metadata-bearing MarkIts image from the file tree
- **THEN** Studio registers or resolves its resource and inserts a document render without private MarkIts metadata.

#### Scenario: Replace a manuscript image
- **WHEN** a user replaces a manuscript image with a capture resource
- **THEN** its generated document output is used while alt text, caption and display settings are retained.

#### Scenario: Publish a referenced capture
- **WHEN** a manuscript containing a managed capture image is published
- **THEN** its rendered document image is included and no private MarkIts source, operation recording or embedded original is copied into publication.
