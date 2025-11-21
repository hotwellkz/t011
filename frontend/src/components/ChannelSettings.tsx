import React, { useState, useEffect } from 'react'
import '../App.css'
import { apiFetch, apiFetchJson, ApiError } from '../lib/apiClient'

type Language = 'ru' | 'kk' | 'en'

interface ChannelAutomation {
  enabled: boolean
  frequencyPerDay: number
  times: string[]
  daysOfWeek: string[]
  autoApproveAndUpload: boolean
  useOnlyFreshIdeas: boolean
  maxActiveTasks: number
  lastRunAt?: number | null
}

interface Channel {
  id: string
  name: string
  description: string
  language: Language
  durationSeconds: number
  ideaPromptTemplate: string
  videoPromptTemplate: string
  gdriveFolderId?: string | null
  externalUrl?: string | undefined
  automation?: ChannelAutomation
}

const ChannelSettings: React.FC = () => {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [success, setSuccess] = useState<string>('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    language: 'ru' as Language,
    durationSeconds: 8,
    ideaPromptTemplate: '',
    videoPromptTemplate: '',
    gdriveFolderId: '',
    externalUrl: '',
    automation: {
      enabled: false,
      frequencyPerDay: 0,
      times: [''],
      daysOfWeek: [] as string[],
      autoApproveAndUpload: false,
      useOnlyFreshIdeas: false,
      maxActiveTasks: 2,
    } as ChannelAutomation,
  })

  useEffect(() => {
    fetchChannels()
  }, [])

  const getErrorMessage = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.isNetworkError || !err.status || err.status >= 500 || err.status === 404) {
        return 'Не удалось подключиться к серверу. Проверьте настройки backend API.'
      }
      return err.message
    }
    if (err instanceof Error) return err.message
    return 'Неизвестная ошибка'
  }

  const fetchChannels = async () => {
    try {
      const data = await apiFetchJson<Channel[]>('/api/channels')
      setChannels(data)
    } catch (err) {
      console.error('[ChannelSettings] Failed to load channels', err)
      setError(getErrorMessage(err))
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      language: 'ru',
      durationSeconds: 8,
      ideaPromptTemplate: '',
      videoPromptTemplate: '',
      gdriveFolderId: '',
      externalUrl: '',
      automation: {
        enabled: false,
        frequencyPerDay: 0,
        times: [''],
        daysOfWeek: [],
        autoApproveAndUpload: false,
        useOnlyFreshIdeas: false,
        maxActiveTasks: 2,
      },
    })
    setEditingId(null)
  }

  const handleEdit = (channel: Channel) => {
    setFormData({
      name: channel.name,
      description: channel.description,
      language: channel.language,
      durationSeconds: channel.durationSeconds,
      ideaPromptTemplate: channel.ideaPromptTemplate,
      videoPromptTemplate: channel.videoPromptTemplate,
      gdriveFolderId: channel.gdriveFolderId || '',
      externalUrl: channel.externalUrl || '',
      automation: channel.automation || {
        enabled: false,
        frequencyPerDay: 0,
        times: [''],
        daysOfWeek: [],
        autoApproveAndUpload: false,
        useOnlyFreshIdeas: false,
        maxActiveTasks: 2,
      },
    })
    setEditingId(channel.id)
    setError('')
    setSuccess('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const url = editingId ? `/api/channels/${editingId}` : '/api/channels'
      const method = editingId ? 'PUT' : 'POST'

      await apiFetchJson(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      resetForm()
      setSuccess(editingId ? 'Канал успешно обновлён!' : 'Канал успешно создан!')
      fetchChannels()
    } catch (err) {
      console.error('[ChannelSettings] Failed to save channel', err)
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Вы уверены, что хотите удалить этот канал?')) return

    setLoading(true)
    setError('')
    setSuccess('')

    try {
      await apiFetch(`/api/channels/${id}`, {
        method: 'DELETE',
      })
      setSuccess('Канал успешно удалён!')
      fetchChannels()
    } catch (err) {
      console.error('[ChannelSettings] Failed to delete channel', err)
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="channel-settings-container">
      <div className="card">
        <h2>{editingId ? 'Редактировать канал' : 'Добавить канал'}</h2>
        {error && (
          <div className="error channel-settings-alert" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="success channel-settings-alert" role="alert">
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label>Название канала</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder="Например: Бабушка и Дедушка Life"
              required
            />
          </div>

          <div className="input-group">
            <label>Описание стиля</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder="Краткое описание стиля канала"
            />
          </div>

          <div className="input-group">
            <label>Основной язык</label>
            <select
              value={formData.language}
              onChange={(e) =>
                setFormData({ ...formData, language: e.target.value as Language })
              }
            >
              <option value="ru">Русский</option>
              <option value="kk">Қазақша</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="input-group">
            <label>Длительность (сек)</label>
            <input
              type="number"
              min="1"
              max="60"
              value={formData.durationSeconds}
              onChange={(e) =>
                setFormData({ ...formData, durationSeconds: parseInt(e.target.value) || 8 })
              }
              required
            />
          </div>

          <div className="input-group">
            <label>Промпт для генерации идей</label>
            <textarea
              value={formData.ideaPromptTemplate}
              onChange={(e) =>
                setFormData({ ...formData, ideaPromptTemplate: e.target.value })
              }
              placeholder="Сгенерируй 5 идей для очень смешных 8-секундных видео..."
              rows={6}
              required
            />
            <small style={{ color: '#718096', marginTop: '0.5rem', display: 'block' }}>
              Этот промпт будет использоваться для генерации идей через OpenAI. 
              Можете использовать плейсхолдеры: {'{{DURATION}}'}, {'{{LANGUAGE}}'}, {'{{DESCRIPTION}}'}
            </small>
          </div>

          <div className="input-group">
            <label>Промпт для генерации Veo-промпта + названия</label>
            <textarea
              value={formData.videoPromptTemplate}
              onChange={(e) =>
                setFormData({ ...formData, videoPromptTemplate: e.target.value })
              }
              placeholder='На основе следующей идеи сгенерируй детализированный промпт для Veo 3.1 Fast...'
              rows={8}
              required
            />
            <small style={{ color: '#718096', marginTop: '0.5rem', display: 'block' }}>
              Используйте {'{{IDEA_TEXT}}'} для подстановки выбранной идеи. 
              OpenAI должен вернуть JSON с полями veo_prompt и video_title.
            </small>
          </div>

          <div className="input-group">
            <label>ID папки Google Drive (необязательно)</label>
            <input
              type="text"
              value={formData.gdriveFolderId}
              onChange={(e) =>
                setFormData({ ...formData, gdriveFolderId: e.target.value })
              }
              placeholder="Например, 1AbCdEfGh..."
            />
            <small style={{ color: '#718096', marginTop: '0.5rem', display: 'block' }}>
              Видео для этого канала будут сохраняться в эту папку. Если пусто — используется папка по умолчанию из настроек сервера.
            </small>
          </div>

          <div className="input-group">
            <label>Ссылка на канал (опционально)</label>
            <input
              type="text"
              value={formData.externalUrl}
              onChange={(e) => {
                const value = e.target.value
                // Валидация на клиенте (опционально)
                if (value && value.trim() && !value.startsWith('http://') && !value.startsWith('https://')) {
                  setError('Ссылка должна начинаться с http:// или https://')
                } else {
                  setError('')
                }
                setFormData({ ...formData, externalUrl: value })
              }}
              placeholder="https://www.youtube.com/@example"
            />
            <small style={{ color: '#718096', marginTop: '0.5rem', display: 'block' }}>
              Ссылка на YouTube-канал. Можно оставить пустым.
            </small>
          </div>

          {/* Блок автоматизации */}
          <div style={{ marginTop: '2rem', padding: '1.5rem', border: '2px solid #e2e8f0', borderRadius: '10px', background: '#f7fafc' }}>
            <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Автоматизация роликов</h3>
            
            <div className="input-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formData.automation.enabled}
                  onChange={(e) => {
                    setFormData({
                      ...formData,
                      automation: { ...formData.automation, enabled: e.target.checked }
                    })
                  }}
                />
                <span>Автоматизация включена</span>
              </label>
            </div>

            {formData.automation.enabled && (
              <>
                <div className="input-group">
                  <label>Частота</label>
                  <select
                    value={formData.automation.frequencyPerDay}
                    onChange={(e) => {
                      const freq = parseInt(e.target.value)
                      const times = freq > 0 ? Array(freq).fill('').map((_, i) => i === 0 ? '10:00' : '') : ['']
                      setFormData({
                        ...formData,
                        automation: { ...formData.automation, frequencyPerDay: freq, times }
                      })
                    }}
                  >
                    <option value={0}>Нет</option>
                    <option value={1}>1 ролик в день</option>
                    <option value={2}>2 ролика в день</option>
                    <option value={3}>3 ролика в день</option>
                  </select>
                </div>

                {formData.automation.frequencyPerDay > 0 && (
                  <div className="input-group">
                    <label>Время генерации (HH:mm)</label>
                    {Array.from({ length: formData.automation.frequencyPerDay }).map((_, index) => (
                      <input
                        key={index}
                        type="time"
                        value={formData.automation.times[index] || ''}
                        onChange={(e) => {
                          const newTimes = [...formData.automation.times]
                          newTimes[index] = e.target.value
                          setFormData({
                            ...formData,
                            automation: { ...formData.automation, times: newTimes }
                          })
                        }}
                        style={{ marginBottom: '0.5rem' }}
                      />
                    ))}
                  </div>
                )}

                <div className="input-group">
                  <label>Дни недели</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day, index) => {
                      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                      const dayNumber = String(index + 1)
                      const isChecked = formData.automation.daysOfWeek.includes(dayNames[index]) || 
                                       formData.automation.daysOfWeek.includes(dayNumber)
                      return (
                        <label key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              const newDays = [...formData.automation.daysOfWeek]
                              if (e.target.checked) {
                                if (!newDays.includes(dayNames[index])) newDays.push(dayNames[index])
                                if (!newDays.includes(dayNumber)) newDays.push(dayNumber)
                              } else {
                                const idx1 = newDays.indexOf(dayNames[index])
                                const idx2 = newDays.indexOf(dayNumber)
                                if (idx1 >= 0) newDays.splice(idx1, 1)
                                if (idx2 >= 0) newDays.splice(idx2, 1)
                              }
                              setFormData({
                                ...formData,
                                automation: { ...formData.automation, daysOfWeek: newDays }
                              })
                            }}
                          />
                          <span>{day}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="input-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.automation.autoApproveAndUpload}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          automation: { ...formData.automation, autoApproveAndUpload: e.target.checked }
                        })
                      }}
                    />
                    <span>Автоматически одобрять и отправлять в Google Drive / YouTube</span>
                  </label>
                </div>

                <div className="input-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formData.automation.useOnlyFreshIdeas}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          automation: { ...formData.automation, useOnlyFreshIdeas: e.target.checked }
                        })
                      }}
                    />
                    <span>Использовать только новые идеи (не повторяться)</span>
                  </label>
                </div>

                <div className="input-group">
                  <label>Максимум активных генераций на канал</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={formData.automation.maxActiveTasks}
                    onChange={(e) => {
                      setFormData({
                        ...formData,
                        automation: { ...formData.automation, maxActiveTasks: parseInt(e.target.value) || 2 }
                      })
                    }}
                  />
                </div>
              </>
            )}
          </div>

          <div className="channel-settings-form-actions">
            <button
              type="submit"
              className="button channel-settings-submit-button"
              disabled={loading}
            >
              {loading ? 'Сохранение...' : editingId ? 'Сохранить изменения' : 'Создать канал'}
            </button>
            {editingId && (
              <button
                type="button"
                className="button channel-settings-cancel-button"
                onClick={resetForm}
                disabled={loading}
              >
                Отмена
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Список каналов</h2>
        <div className="channel-list">
          {channels.length === 0 ? (
            <p className="channel-list-empty">Каналы не найдены</p>
          ) : (
            <>
              {/* Десктопная таблица */}
              <div className="channel-list-table-wrapper">
                <table className="channel-list-table">
                  <thead>
                    <tr>
                      <th>Имя</th>
                      <th>Язык</th>
                      <th>Длительность</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((channel) => (
                      <tr key={channel.id}>
                        <td>
                          <strong>{channel.name}</strong>
                          {channel.description && (
                            <div className="channel-description">{channel.description}</div>
                          )}
                        </td>
                        <td>{channel.language.toUpperCase()}</td>
                        <td>{channel.durationSeconds}с</td>
                        <td>
                          <div className="channel-actions-desktop">
                            <button
                              className="button"
                              onClick={() => handleEdit(channel)}
                              disabled={loading}
                            >
                              Редактировать
                            </button>
                            <button
                              className="button button-danger"
                              onClick={() => handleDelete(channel.id)}
                              disabled={loading}
                            >
                              Удалить
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Мобильные карточки */}
              <div className="channel-list-cards">
                {channels.map((channel) => (
                  <div key={channel.id} className="channel-card-mobile">
                    <div className="channel-card-mobile__header">
                      <div className="channel-card-mobile__info">
                        <h3 className="channel-card-mobile__name">{channel.name}</h3>
                        {channel.description && (
                          <p className="channel-card-mobile__description">{channel.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="channel-card-mobile__meta">
                      <span className="channel-card-mobile__meta-item">
                        <strong>Язык:</strong> {channel.language.toUpperCase()}
                      </span>
                      <span className="channel-card-mobile__meta-item">
                        <strong>Длительность:</strong> {channel.durationSeconds}с
                      </span>
                    </div>
                    <div className="channel-card-mobile__actions">
                      <button
                        className="button channel-card-mobile__button"
                        onClick={() => handleEdit(channel)}
                        disabled={loading}
                      >
                        Редактировать
                      </button>
                      <button
                        className="button button-danger channel-card-mobile__button"
                        onClick={() => handleDelete(channel.id)}
                        disabled={loading}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ChannelSettings
