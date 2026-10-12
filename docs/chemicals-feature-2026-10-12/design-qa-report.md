# Pheno Chemicals design QA

Owner: Pheno. Archetype: scientific-workbench, `pheno.p2-data-grid`. Repeated task: enter a material row, review its parsed molecular structure and save a validated definition. The dominant object is the registry row and its molecular evidence, within the existing laboratory shell.

The registry receives the remaining width beside a 360px inspector (280–480px). Each pane has a bounded scroll owner. At medium/compact widths the registry and focused inspector alternate; they are not squeezed side by side. Geometry/visibility persist locally, while private input values do not. Hide/show, keyboard resize, focus, restore and reset preserve selected row data. The layout keeps the existing global navigation/brand instead of adding a second shell.

Sources: canonical Pheno design whitepaper, selection matrix and Pheno reference; existing `pheno-lab/src/app/globals.css` tokens and approved `public/brand`/Pheno web-icon assets. No logo or icon-pack changes. Neutral surfaces, graphite save controls, green selection/focus, real RDKit molecular graphics and concise source-status labels express the scientific workbench.

Implemented states: populated/empty, required SMILES, legacy unvalidated notation, pending preview, valid preview, saving/saved, disabled actions, invalid SMILES with preserved input, duplicate/stale-row conflict, failed operation with draft retained, and hidden/404 for users without explicit access. Offline operations fail with input preserved; they do not claim a queued save.

| Viewport   | English | Chinese | Layout and evidence                                     |
| ---------- | ------- | ------- | ------------------------------------------------------- |
| 1440 × 900 | passed  | passed  | Grid and inspector; actual molecular image              |
| 1024 × 768 | passed  | passed  | Registry and explicit focused inspector                 |
| 390 × 844  | passed  | passed  | Stacked labelled row inputs and focused structure       |
| 320 × 700  | passed  | passed  | Bounded panes, usable search/actions, no outer overflow |

Automated checks cover no outer horizontal/vertical overflow, image loading, language-specific controls and zero page errors. Desktop/mobile screenshots were inspected; a narrow search-toolbar issue found during review was corrected before release. Private/generated QA remains outside Git. Controls have native labels/accessibility names, keyboard focus, at least 44px touch height and text status alongside icons. The width slider was operated by keyboard and verified at 380px. Hide while focused restores the registry rather than leaving an empty surface.

The first production check with a full 40-row registry found vertical document overflow that the original single-row fixture did not expose. Offscreen screen-reader labels had the document as their absolute-position containing block. Positioning the existing registry scroll owner bounds those labels without changing their accessible names or material data. The browser fixture now contains 45 synthetic materials, mixed empty/populated SMILES and long bilingual category labels; it verifies all 40 rows on the first page, scrolling to the final row, visible pagination, and bounded registry/focused inspector at every viewport above. Full verify and all 26 browser tests passed again after this correction.

Local validation passed: 224 unit tests, 105 guarded real-PostgreSQL integration tests, 26 browser tests, schema drift, full verify (format/lint/boundaries/deployment checks/TypeScript/build), and design-brief validation. Existing lint warnings remain; no lint errors. The JV photo check now waits for complete image loading while preserving its original assertion.

Production deployment and real-account acceptance are recorded separately after they occur. This QA record does not claim that laboratory users have accepted the feature or that notation validation verifies physical material identity/purity.
