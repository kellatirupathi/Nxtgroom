# AI quality gate

The labelled manifest in `grooming_api_node/test/fixtures/ai-quality-golden.json` defines the minimum scenario coverage for appearance evaluation: gender, supported attire, poor lighting, partial framing, groups, mirrors, occlusion, and no-person images.

Before changing the model or prompts, attach consented test images outside Git, run the manifest through the staging evaluator, and record per-scenario false-positive, false-negative, unassessed, and retake rates. A release must not increase false compliance, and no-person/group cases must remain unassessed. The manifest test prevents a future test-set revision from silently dropping a risk category.
