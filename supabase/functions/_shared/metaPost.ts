// Facebook Page + Instagram publishing via the Graph API, shared by autopost (run_due + send_now).
// Supports text, a single image, AND video (Instagram Reels / Facebook video). A media URL ending
// in .mp4/.mov is treated as video. Instagram video needs the container to finish processing
// before publish, so we poll its status briefly.
const GRAPH = 'https://graph.facebook.com/v19.0'

const isVideo = (url?: string | null) => !!url && /\.(mp4|mov|m4v)(\?|$)/i.test(url)

async function jpost(url: string, params: Record<string, string>): Promise<any> {
  return await fetch(url, { method: 'POST', body: new URLSearchParams(params) }).then((r) => r.json()).catch(() => ({}))
}

export async function postFacebook(pageId: string, token: string, message: string, mediaUrl?: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (isVideo(mediaUrl)) {
      const r = await jpost(`${GRAPH}/${pageId}/videos`, { file_url: mediaUrl!, description: message, access_token: token })
      return r?.id ? { ok: true, id: r.id } : { ok: false, error: r?.error?.message ?? 'Facebook: ошибка загрузки видео' }
    }
    const url = `${GRAPH}/${pageId}/${mediaUrl ? 'photos' : 'feed'}`
    const params = mediaUrl ? { url: mediaUrl, caption: message, access_token: token } : { message, access_token: token }
    const r = await jpost(url, params)
    return (r?.id || r?.post_id) ? { ok: true, id: r.id ?? r.post_id } : { ok: false, error: r?.error?.message ?? 'Facebook отклонил пост' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}

export async function postInstagram(igUserId: string, token: string, caption: string, mediaUrl?: string | null): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (!mediaUrl) return { ok: false, error: 'Instagram требует медиа (ссылку на картинку или видео).' }
    const video = isVideo(mediaUrl)
    const createParams = video
      ? { media_type: 'REELS', video_url: mediaUrl, caption, access_token: token }
      : { image_url: mediaUrl, caption, access_token: token }
    const create = await jpost(`${GRAPH}/${igUserId}/media`, createParams)
    if (!create?.id) return { ok: false, error: create?.error?.message ?? 'Instagram: ошибка создания медиа' }

    // video containers need processing time before publish — poll status briefly (short clips only)
    if (video) {
      let ready = false
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const st = await fetch(`${GRAPH}/${create.id}?fields=status_code&access_token=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => ({}))
        if (st?.status_code === 'FINISHED') { ready = true; break }
        if (st?.status_code === 'ERROR') return { ok: false, error: 'Instagram: видео не обработалось' }
      }
      if (!ready) return { ok: false, error: 'Instagram: видео ещё обрабатывается — попробуйте позже или запланируйте на минуту позднее.' }
    }

    const pub = await jpost(`${GRAPH}/${igUserId}/media_publish`, { creation_id: create.id, access_token: token })
    return pub?.id ? { ok: true, id: pub.id } : { ok: false, error: pub?.error?.message ?? 'Instagram: ошибка публикации' }
  } catch (e) { return { ok: false, error: String(e).slice(0, 150) } }
}
