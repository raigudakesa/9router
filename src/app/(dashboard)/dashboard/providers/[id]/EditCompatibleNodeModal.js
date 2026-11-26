"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select, Tooltip } from "@/shared/components";
import HeaderFormModal from "./HeaderFormModal";

// Prefilled test payload — mirrors the probe body /api/models/test sends
// (max_tokens 1024: reasoning models burn budget on CoT, see issue #3010).
const DEFAULT_TEST_PAYLOAD = {
  messages: [{ role: "user", content: "ping" }],
  max_tokens: 1024,
  stream: false,
};

export default function EditCompatibleNodeModal({ isOpen, node, onSave, onClose, isAnthropic }) {
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    apiType: "chat",
    baseUrl: "https://api.openai.com/v1",
  });
  const [customHeaders, setCustomHeaders] = useState([]);
  const [fallbackHeaders, setFallbackHeaders] = useState([]);
  const [saving, setSaving] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [headerForm, setHeaderForm] = useState({ open: false, mode: "add", index: null, target: "custom" });
  const [testPayloadText, setTestPayloadText] = useState("");

  useEffect(() => {
    if (node) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        apiType: node.apiType || "chat",
        baseUrl: node.baseUrl || (isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
      });
      setCustomHeaders(Array.isArray(node.customHeaders) ? node.customHeaders.map((h) => ({ ...h })) : []);
      setFallbackHeaders(Array.isArray(node.fallbackHeaders) ? node.fallbackHeaders.map((h) => ({ ...h })) : []);
      setTestPayloadText(JSON.stringify(node.testPayload || DEFAULT_TEST_PAYLOAD, null, 2));
    }
  }, [node, isAnthropic]);

  const apiTypeOptions = [
    { value: "chat", label: "Chat Completions" },
    { value: "responses", label: "Responses API" },
  ];

  const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const isInvalidHeaderName = (name) => name.trim() !== "" && !HEADER_NAME_RE.test(name.trim());
  const hasInvalidHeader = [...customHeaders, ...fallbackHeaders].some((h) => isInvalidHeaderName(h.name));

  const rowsFor = (target) => (target === "fallback" ? fallbackHeaders : customHeaders);
  const setRowsFor = (target, updater) => {
    if (target === "fallback") setFallbackHeaders(updater);
    else setCustomHeaders(updater);
  };

  const removeHeader = (target, index) => setRowsFor(target, (rows) => rows.filter((_, i) => i !== index));

  const openAddHeader = (target) => setHeaderForm({ open: true, mode: "add", index: null, target });
  const openEditHeader = (target, index) => setHeaderForm({ open: true, mode: "edit", index, target });
  const closeHeaderForm = () => setHeaderForm((f) => ({ ...f, open: false, index: null }));

  const submitHeaderForm = (row) => {
    const { target, mode, index } = headerForm;
    setRowsFor(target, (rows) => {
      if (mode === "edit" && index != null) {
        return rows.map((r, i) => (i === index ? row : r));
      }
      // add: replace an existing same-name (case-insensitive) row, else append
      const lower = row.name.toLowerCase();
      const existingIdx = rows.findIndex((r) => r.name.trim().toLowerCase() === lower);
      if (existingIdx >= 0) return rows.map((r, i) => (i === existingIdx ? row : r));
      return [...rows, row];
    });
    closeHeaderForm();
  };

  const normalizeRows = (rows) =>
    rows
      .filter((h) => h.name.trim() !== "")
      .map((h) => ({ name: h.name.trim(), value: h.value, ttlMinutes: h.ttlMinutes ?? null }));

  const formatPersist = (ttl) => (ttl === null || ttl === undefined ? "-" : ttl === 0 ? "Permanent" : `${ttl} min`);

  // Shared table for the primary (Request Headers) and fallback lists.
  const renderHeaderTable = (target, rows, emptyText, showPersist) => (
    <div className="border border-border-subtle rounded-[10px] overflow-hidden">
      {/* table-fixed keeps columns within the container so the Actions column
          can never be pushed out of view by a long value or "Permanent". */}
      <table className="w-full text-sm table-fixed">
        <thead className="bg-surface-2 text-text-muted">
          <tr>
            <th className={`text-left font-medium px-3 py-2 ${showPersist ? "w-[28%]" : "w-[32%]"}`}>Name</th>
            <th className="text-left font-medium px-3 py-2">Value</th>
            {showPersist && <th className="text-left font-medium px-3 py-2 w-[92px]">Persist</th>}
            <th className="text-right font-medium px-3 py-2 w-[96px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={showPersist ? 4 : 3} className="px-3 py-4 text-center text-text-muted">{emptyText}</td>
            </tr>
          )}
          {rows.map((h, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <td className="px-3 py-2 font-mono truncate" title={h.name}>{h.name}</td>
              <td className="px-3 py-2 truncate" title={h.value}>{h.value}</td>
              {showPersist && <td className="px-3 py-2 truncate">{formatPersist(h.ttlMinutes)}</td>}
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                  <Tooltip text="Edit" position="top">
                    <Button type="button" variant="ghost" size="sm" icon="edit" className="!px-2" onClick={() => openEditHeader(target, i)} />
                  </Tooltip>
                  <Tooltip text="Delete" position="top">
                    <Button type="button" variant="ghost" size="sm" icon="delete" className="!px-2" onClick={() => removeHeader(target, i)} />
                  </Tooltip>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Empty textarea → no custom payload (built-in probe body is used).
  const parseTestPayload = () => {
    if (!testPayloadText.trim()) return { value: null, error: null };
    try {
      const parsed = JSON.parse(testPayloadText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { value: null, error: "Payload must be a JSON object" };
      }
      return { value: parsed, error: null };
    } catch (e) {
      return { value: null, error: `Invalid JSON: ${e.message}` };
    }
  };
  const { value: testPayloadValue, error: testPayloadError } = parseTestPayload();

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || hasInvalidHeader || testPayloadError) return;
    setSaving(true);
    try {
      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
      };
      if (!isAnthropic) {
        payload.apiType = formData.apiType;
      }
      if (!isAnthropic) {
        payload.testPayload = testPayloadValue;
      }
      payload.customHeaders = normalizeRows(customHeaders);
      payload.fallbackHeaders = normalizeRows(fallbackHeaders).map(({ name, value }) => ({ name, value }));
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: isAnthropic ? "anthropic-compatible" : "openai-compatible",
          modelId: checkModelId.trim() || undefined,
          testPayload: isAnthropic ? undefined : testPayloadValue,
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title={`Edit ${isAnthropic ? "Anthropic" : "OpenAI"} Compatible`} onClose={onClose} disableEscape={headerForm.open} closeOnOverlay={!headerForm.open}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={`${isAnthropic ? "Anthropic" : "OpenAI"} Compatible (Prod)`}
          hint="Required. A friendly label for this node."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          hint="Required. Used as the provider prefix for model IDs."
        />
        {!isAnthropic && (
          <Select
            label="API Type"
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
          hint={`Use the base URL (ending in /v1) for your ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible API.`}
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Request Headers</label>
            <Button type="button" variant="secondary" onClick={() => openAddHeader("custom")}>
              + Add
            </Button>
          </div>
          {renderHeaderTable("custom", customHeaders, "No custom headers", true)}
          <p className="text-xs text-neutral-500">
            Overrides preset headers of the same name. Persist reuses the resolved
            value per connection (0 minutes = permanent, until restart).
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Fallback Headers</label>
            <Button type="button" variant="secondary" onClick={() => openAddHeader("fallback")}>
              + Add
            </Button>
          </div>
          {renderHeaderTable("fallback", fallbackHeaders, "No fallback headers", false)}
          <p className="text-xs text-neutral-500">
            Default values: sent when the matching Request Header is unset, empty, or its{' '}
            <code>{"{forward:Name}"}</code> source header is absent. Entries with no matching
            Request Header are always sent. Same tags work here, including <code>{"{forward:Name}"}</code>.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            label="API Key (for Check)"
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!checkKey || validating || !formData.baseUrl.trim()} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder="e.g. my-model-id"
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        {!isAnthropic && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Test Payload (JSON)</label>
            <textarea
              className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[160px] focus:outline-none focus:ring-1 focus:ring-primary"
              spellCheck={false}
              value={testPayloadText}
              onChange={(e) => setTestPayloadText(e.target.value)}
              placeholder='{"messages":[{"role":"user","content":"ping"}],"max_tokens":1024}'
            />
            {testPayloadError ? (
              <p className="text-xs text-red-500 break-words">{testPayloadError}</p>
            ) : (
              <p className="text-xs text-neutral-500">
                Sent as the probe body when testing this node&apos;s models. `model` and `stream`
                are always set by the tester. Leave empty to use the built-in payload.
              </p>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving || hasInvalidHeader || !!testPayloadError}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
        <HeaderFormModal
          isOpen={headerForm.open}
          mode={headerForm.mode}
          initial={headerForm.index != null ? rowsFor(headerForm.target)[headerForm.index] : null}
          existingNames={rowsFor(headerForm.target)
            .filter((_, i) => i !== headerForm.index)
            .map((h) => h.name.trim().toLowerCase())}
          onSubmit={submitHeaderForm}
          onClose={closeHeaderForm}
          showPersist={headerForm.target !== "fallback"}
        />
      </div>
    </Modal>
  );
}

EditCompatibleNodeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    apiType: PropTypes.string,
    baseUrl: PropTypes.string,
    customHeaders: PropTypes.arrayOf(
      PropTypes.shape({ name: PropTypes.string, value: PropTypes.string, ttlMinutes: PropTypes.number })
    ),
    fallbackHeaders: PropTypes.arrayOf(
      PropTypes.shape({ name: PropTypes.string, value: PropTypes.string })
    ),
    testPayload: PropTypes.object,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  isAnthropic: PropTypes.bool,
};
