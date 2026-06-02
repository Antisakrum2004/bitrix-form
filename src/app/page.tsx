'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/hooks/use-toast'
import {
  Clock,
  Send,
  TestTube,
  Save,
  CheckCircle2,
  XCircle,
  Loader2,
  Bell,
  FileText,
  BarChart3,
  Settings2,
  Github,
} from 'lucide-react'

interface Settings {
  reminder1Time: string
  reminder2Time: string
  reportTime: string
  enabledDays: number[]
}

const DAY_LABELS: Record<number, string> = {
  1: 'Пн',
  2: 'Вт',
  3: 'Ср',
  4: 'Чт',
  5: 'Пт',
  6: 'Сб',
  0: 'Вс',
}

const DEFAULT_SETTINGS: Settings = {
  reminder1Time: '18:00',
  reminder2Time: '19:00',
  reportTime: '20:00',
  enabledDays: [1, 2, 3, 4, 5],
}

export default function Home() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ success: boolean; output: string } | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setSettings({ ...DEFAULT_SETTINGS, ...data })
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const toggleDay = (day: number) => {
    setSettings(prev => ({
      ...prev,
      enabledDays: prev.enabledDays.includes(day)
        ? prev.enabledDays.filter(d => d !== day)
        : [...prev.enabledDays, day].sort()
    }))
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await res.json()
      if (data.success) {
        toast({
          title: 'Настройки сохранены',
          description: `Расписание обновлено и запушено в GitHub${data.gitWarning ? ' (с предупреждением)' : ''}`,
        })
      } else {
        toast({ title: 'Ошибка', description: data.error, variant: 'destructive' })
      }
    } catch (err: any) {
      toast({ title: 'Ошибка сети', description: err.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: string, body: Record<string, any> = {}) => {
    setActionLoading(action)
    setLastResult(null)
    try {
      let url = ''
      let reqBody = body
      switch (action) {
        case 'send-inspector':
          url = '/api/send-report'
          reqBody = { mode: 'group' }
          break
        case 'send-inspector-private':
          url = '/api/send-report'
          reqBody = { mode: 'private' }
          break
        case 'send-reminder-1':
          url = '/api/send-reminder'
          reqBody = { round: 1 }
          break
        case 'send-reminder-2':
          url = '/api/send-reminder'
          reqBody = { round: 2 }
          break
        case 'send-productivity':
          url = '/api/send-productivity'
          reqBody = { mode: 'group' }
          break
        case 'test-inspector':
          url = '/api/test-single'
          reqBody = { script: 'inspector', mode: 'private' }
          break
        case 'test-reminder':
          url = '/api/test-single'
          reqBody = { script: 'reminder', round: 1 }
          break
        case 'test-productivity':
          url = '/api/test-single'
          reqBody = { script: 'productivity', mode: 'group' }
          break
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      })
      const data = await res.json()
      setLastResult({ success: data.success, output: data.output || data.error || '' })

      if (data.success) {
        toast({ title: 'Успешно', description: `${action} выполнен` })
      } else {
        toast({ title: 'Ошибка', description: data.error, variant: 'destructive' })
      }
    } catch (err: any) {
      toast({ title: 'Ошибка сети', description: err.message, variant: 'destructive' })
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <Settings2 className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">EOD Inspector</h1>
            <p className="text-sm text-muted-foreground">Панель управления отчётами</p>
          </div>
          <Badge variant="outline" className="ml-auto gap-1">
            <Github className="h-3 w-3" />
            GitHub Actions
          </Badge>
        </div>

        {/* Schedule Settings */}
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Расписание (МСК)
            </CardTitle>
            <CardDescription>
              Время отправки уведомлений и отчётов. Изменения сохраняются в GitHub Actions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <Bell className="h-3.5 w-3.5 text-amber-500" />
                  Напоминание #1
                </label>
                <Input
                  type="time"
                  value={settings.reminder1Time}
                  onChange={e => setSettings(prev => ({ ...prev, reminder1Time: e.target.value }))}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <Bell className="h-3.5 w-3.5 text-red-500" />
                  Напоминание #2
                </label>
                <Input
                  type="time"
                  value={settings.reminder2Time}
                  onChange={e => setSettings(prev => ({ ...prev, reminder2Time: e.target.value }))}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-blue-500" />
                  Отчёт + Рейтинг
                </label>
                <Input
                  type="time"
                  value={settings.reportTime}
                  onChange={e => setSettings(prev => ({ ...prev, reportTime: e.target.value }))}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Дни недели</label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5, 6, 0].map(day => (
                  <button
                    key={day}
                    onClick={() => toggleDay(day)}
                    className={`h-9 w-9 rounded-md text-sm font-medium transition-colors ${
                      settings.enabledDays.includes(day)
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    {DAY_LABELS[day]}
                  </button>
                ))}
              </div>
            </div>

            <Button onClick={saveSettings} disabled={saving} className="w-full">
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Сохранение и пуш в GitHub...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Сохранить и запушить
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Send Reports */}
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Send className="h-5 w-5" />
              Отправка отчётов
            </CardTitle>
            <CardDescription>
              Отправить отчёт прямо сейчас в Общий чат или в личку
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                variant="outline"
                onClick={() => runAction('send-inspector')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'send-inspector' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                ЕОД-сводка → Общий чат
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction('send-inspector-private')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'send-inspector-private' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                ЕОД-сводка → Личка
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction('send-reminder-1')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'send-reminder-1' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Bell className="h-4 w-4 mr-2 text-amber-500" />
                )}
                Напоминание #1
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction('send-reminder-2')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'send-reminder-2' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Bell className="h-4 w-4 mr-2 text-red-500" />
                )}
                Напоминание #2
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction('send-productivity')}
                disabled={actionLoading !== null}
                className="justify-start sm:col-span-2"
              >
                {actionLoading === 'send-productivity' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <BarChart3 className="h-4 w-4 mr-2" />
                )}
                Рейтинг продуктивности → Общий чат
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Test (Dry Run) */}
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <TestTube className="h-5 w-5" />
              Пробный запуск (Dry Run)
            </CardTitle>
            <CardDescription>
              Запуск без отправки сообщений — только формирование отчёта
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Button
                variant="secondary"
                onClick={() => runAction('test-inspector')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'test-inspector' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                ЕОД-сводка
              </Button>
              <Button
                variant="secondary"
                onClick={() => runAction('test-reminder')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'test-reminder' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Bell className="h-4 w-4 mr-2" />
                )}
                Напоминание
              </Button>
              <Button
                variant="secondary"
                onClick={() => runAction('test-productivity')}
                disabled={actionLoading !== null}
                className="justify-start"
              >
                {actionLoading === 'test-productivity' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <BarChart3 className="h-4 w-4 mr-2" />
                )}
                Рейтинг
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Result */}
        {lastResult && (
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                {lastResult.success ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-500" />
                )}
                Результат
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-3 rounded-md text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                {lastResult.output || 'Нет вывода'}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-muted-foreground py-4">
          EOD Inspector Bot • Bitrix24 • GitHub Actions
        </div>
      </div>
    </div>
  )
}
