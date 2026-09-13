// `best` excludes explicit audio-only/video-only streams but accepts missing codec
// metadata. X's progressive MP4 formats commonly have no acodec/vcodec fields.
// Additional `[acodec!=none]` filters would incorrectly exclude these formats.
export const progressiveMp4 = 'best[ext=mp4][protocol=https]/best[ext=mp4][protocol=http]';
