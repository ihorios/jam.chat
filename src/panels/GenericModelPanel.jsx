import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { scopeCaption, scopedPermissions } from '../lib/permissions';
import { modelLabel, itemLabel as itemLabelOf, fieldLabel, relationLabel } from '../lib/labels';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuth } from '../context/auth';
import Icon from '../components/Icon';
import Pagination from '../components/Pagination';
import { usePagination } from '../lib/pagination';

/** Best-effort human label for a related row, whatever shape the model has. */
function rowLabel(row) {
  return row.name || row.title || row.label || row.email || `#${row.id}`;
}

function singular(word) {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function blankValue(field) {
  if (field.type === 'boolean') return false;
  if (field.type === 'integer') return '';
  return '';
}

function emptyForm(model) {
  const form = {};
  for (const field of model.fields) form[field.name] = blankValue(field);
  for (const relation of model.relations) form[relation.name] = [];
  return form;
}

/**
 * CRUD for any model, built entirely from its /api/meta description. A model
 * added on the server gets a working admin screen here with no frontend work;
 * write a bespoke panel only when the generic one is not good enough.
 */
export default function GenericModelPanel({ model }) {
  const { can } = useAuth();

  const [rows, setRows] = useState([]);
  // relationName -> selectable options
  const [options, setOptions] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formData, setFormData] = useState(() => emptyForm(model));
  const [formError, setFormError] = useState('');

  const { t } = useTranslation();
  const plural = modelLabel(t, model);
  const itemLabel = itemLabelOf(t, model, singular(model.label));
  // The question waiting to be answered, or null. See ConfirmDialog.
  const [confirming, setConfirming] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const visibleFields = model.fields.filter((field) => !field.hidden);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listRes = await api(`/api/${model.name}`);
      setRows(listRes[model.name]);

      // Fetch the choices for each relation the current user is allowed to see.
      const relationOptions = {};
      for (const relation of model.relations) {
        if (relation.kind === 'permissionSet') {
          const res = await api('/api/permissions');
          relationOptions[relation.name] = res.models;
        } else if (relation.target && can(`${relation.target}:read`)) {
          const res = await api(`/api/${relation.target}`);
          relationOptions[relation.name] = res[relation.target];
        } else {
          relationOptions[relation.name] = [];
        }
      }
      setOptions(relationOptions);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [model, can]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openCreate = () => {
    setEditing(null);
    setFormData(emptyForm(model));
    setFormError('');
    setIsModalOpen(true);
  };

  const openEdit = (row) => {
    const form = {};
    for (const field of model.fields) {
      if (field.hidden) {
        form[field.name] = ''; // write-only: never prefilled
      } else if (field.type === 'json') {
        form[field.name] = row[field.name] == null ? '' : JSON.stringify(row[field.name], null, 2);
      } else {
        form[field.name] = row[field.name] ?? blankValue(field);
      }
    }
    for (const relation of model.relations) {
      const value = row[relation.name] || [];
      form[relation.name] = relation.kind === 'permissionSet'
        ? [...value]
        : value.map((item) => item.id);
    }
    setEditing(row);
    setFormData(form);
    setFormError('');
    setIsModalOpen(true);
  };

  const toggleInArray = (key, value) => {
    setFormData((prev) => ({
      ...prev,
      [key]: prev[key].includes(value)
        ? prev[key].filter((entry) => entry !== value)
        : [...prev[key], value],
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    const payload = { ...formData };
    for (const field of model.fields) {
      // A blank write-only field on edit means "leave it as it is".
      if (field.hidden && editing && !payload[field.name]) {
        delete payload[field.name];
      }
      // Set-once fields are not offered on edit, so never send them back:
      // the server rejects any attempt to change one.
      if (field.immutable && editing) {
        delete payload[field.name];
      }
      if (field.type === 'json') {
        if (!payload[field.name]) {
          delete payload[field.name];
        } else {
          try {
            payload[field.name] = JSON.parse(payload[field.name]);
          } catch {
            setFormError(`${field.label} is not valid JSON.`);
            return;
          }
        }
      }
    }

    try {
      await api(
        editing ? `/api/${model.name}/${editing.id}` : `/api/${model.name}`,
        { method: editing ? 'PUT' : 'POST', body: payload }
      );
      setIsModalOpen(false);
      loadData();
    } catch (err) {
      setFormError(err.message);
    }
  };

  const handleDelete = async (row) => {
    try {
      await api(`/api/${model.name}/${row.id}`, { method: 'DELETE' });
      loadData();
    } catch (err) {
      // The banner the panel already has, rather than a native alert nobody
      // can translate or style.
      setError(err.message);
    }
  };

  const askToDelete = (row) => setConfirming({
    title: t('panels.confirmDeleteTitle', { item: itemLabel }),
    message: t('panels.confirmDeleteBody', { item: itemLabel.toLowerCase(), name: rowLabel(row) }),
    run: () => handleDelete(row),
  });

  const renderCell = (row, field) => {
    const value = row[field.name];
    if (field.type === 'boolean') {
      return (
        <span className={`status-pill ${value ? 'active' : 'inactive'}`}>
          {t(value ? 'common.yes' : 'common.no')}
        </span>
      );
    }
    if (field.type === 'json') return <code>{JSON.stringify(value)}</code>;
    if (value === null || value === undefined || value === '') {
      return <span className="no-perm">—</span>;
    }
    return String(value);
  };

  const renderInput = (field) => {
    const value = formData[field.name];
    const set = (next) => setFormData((prev) => ({ ...prev, [field.name]: next }));

    if (field.type === 'boolean') {
      return (
        <div className="form-group checkbox-group" key={field.name}>
          <label>
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
            {field.label}
          </label>
        </div>
      );
    }

    const inputType =
      field.type === 'integer' || field.type === 'reference'
        ? 'number'
        : field.hidden ? 'password' : 'text';

    return (
      <div className="form-group" key={field.name}>
        <label>
          {field.label}
          {field.hidden && editing && <small> (blank keeps current)</small>}
        </label>
        {field.type === 'text' || field.type === 'json' ? (
          <textarea rows={field.type === 'json' ? 4 : 2} value={value} onChange={(e) => set(e.target.value)} />
        ) : (
          <input
            type={inputType}
            required={field.required && !(field.hidden && editing)}
            value={value}
            onChange={(e) => set(e.target.value)}
          />
        )}
      </div>
    );
  };

  const renderRelation = (relation) => {
    const chosen = formData[relation.name] || [];
    const available = options[relation.name] || [];

    if (relation.kind === 'permissionSet') {
      return (
        <div className="form-group" key={relation.name}>
          <label>{relationLabel(t, model, relation)}</label>
          <div className="permission-matrix">
            {available.map((entry) => (
              <div key={entry.model} className="matrix-row">
                <div className="matrix-model">
                  <strong>{t(`models.${entry.model}.label`, { defaultValue: entry.label })}</strong>
                </div>
                {entry.scopes.map((scope) => (
                  <div key={scope} className="matrix-actions">
                    {scopeCaption(t, entry, scope) && (
                      <span className="scope-label">{scopeCaption(t, entry, scope)}</span>
                    )}
                    {scopedPermissions(entry, scope).map(({ action, permission }) => (
                      <label key={permission} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={chosen.includes(permission)}
                          onChange={() => toggleInArray(relation.name, permission)}
                        />
                        {t(`panels.action.${action}`)}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="form-group" key={relation.name}>
        <label>{relationLabel(t, model, relation)}</label>
        <div className="permissions-checkboxes">
          {available.length === 0 ? (
            <span className="no-perm">{t('panels.nothingToChoose')}</span>
          ) : (
            available.map((item) => (
              <label key={item.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={chosen.includes(item.id)}
                  onChange={() => toggleInArray(relation.name, item.id)}
                />
                {rowLabel(item)}
              </label>
            ))
          )}
        </div>
      </div>
    );
  };

  /*
   * Search over whatever this model happens to show.
   *
   * The specific panels know what their rows mean and filter on it; this one is
   * whatever model has no panel of its own, so the only honest thing to match on
   * is the text of the columns it is displaying, plus the id. Client-side, over
   * the rows already fetched — the same as everywhere else in the dashboard.
   */
  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return rows;

    return rows.filter((row) => [`#${row.id}`, ...visibleFields.map((f) => row[f.name])]
      .some((value) => String(value ?? '').toLowerCase().includes(term)));
  }, [rows, visibleFields, searchTerm]);

  const page = usePagination(filteredRows);

  if (loading) {
    return (
      <div className="loading-state">
        {t('panels.loading', { label: plural.toLowerCase() })}
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-banner">
        <Icon name="error" filled /> {error}
      </div>
    );
  }

  return (
    <div>
      <div className="panel-toolbar">
        <div className="metrics-row">
          <div className="metric-box">
            <div className="metric-value">{rows.length}</div>
            <div className="metric-label">{t('panels.total', { label: plural })}</div>
          </div>
        </div>
        {/* Both halves matter: holding the permission is not enough if the
            model publishes no create route to use it on. Files are the case —
            uploading grants files:create, but a row only comes into existence
            with bytes attached, so there is nothing to add from a form. */}
        {model.actions.includes('create') && can(`${model.name}:create`) && (
          <button onClick={openCreate} className="btn btn-primary">
            <Icon name="add" /> {t('panels.add', { item: itemLabel })}
          </button>
        )}
      </div>

      <div className="filters-bar">
        <label className="search-field">
          <Icon name="search" />
          <input
            type="text"
            placeholder={t('panels.searchPlaceholder', { label: plural.toLowerCase() })}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </label>
      </div>

      <div className="table-responsive">
        <table className="users-table">
          <thead>
            <tr>
              <th>{t('common.id')}</th>
              {visibleFields.map((field) => (
                <th key={field.name}>{fieldLabel(t, model, field)}</th>
              ))}
              {model.relations.map((relation) => (
                <th key={relation.name}>{relationLabel(t, model, relation)}</th>
              ))}
              <th>{t('panels.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={visibleFields.length + model.relations.length + 2} className="empty-state">
                  {t('panels.noneYet', { label: plural.toLowerCase() })}
                </td>
              </tr>
            ) : (
              page.visible.map((row) => (
                <tr key={row.id}>
                  <td>#{row.id}</td>
                  {visibleFields.map((field) => <td key={field.name}>{renderCell(row, field)}</td>)}
                  {model.relations.map((relation) => (
                    <td key={relation.name}>
                      <div className="permissions-list">
                        {(row[relation.name] || []).length === 0 ? (
                          <span className="no-perm">{t('common.none')}</span>
                        ) : (
                          (row[relation.name] || []).map((item, index) => (
                            <span key={item.id ?? index} className="perm-tag">
                              {typeof item === 'string' ? item : rowLabel(item)}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                  ))}
                  <td>
                    <div className="actions-group">
                      {can(`${model.name}:update`) && (
                        <button onClick={() => openEdit(row)} className="btn-action edit"><Icon name="edit" /> {t('common.edit')}</button>
                      )}
                      {can(`${model.name}:delete`) && (
                        <button onClick={() => askToDelete(row)} className="btn-action delete"><Icon name="delete" /> {t('common.delete')}</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination state={page} />

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>
                {editing
                  ? t('panels.editTitle', { item: itemLabel, id: editing.id })
                  : t('panels.createTitle', { item: itemLabel })}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="close-btn" aria-label={t('common.close')}><Icon name="close" /></button>
            </div>

            {formError && <div className="modal-error">{formError}</div>}

            <form onSubmit={handleSubmit}>
              {model.fields
                .filter((field) => !(field.immutable && editing))
                .map(renderInput)}
              {model.relations.map(renderRelation)}

              <div className="modal-footer">
                <button type="button" onClick={() => setIsModalOpen(false)} className="btn btn-secondary">
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary">
                  {editing ? t('common.saveChanges') : t('panels.createTitle', { item: itemLabel })}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.title}
          message={confirming.message}
          confirmLabel={t('common.delete')}
          destructive
          onCancel={() => setConfirming(null)}
          onConfirm={async () => {
            await confirming.run();
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}
