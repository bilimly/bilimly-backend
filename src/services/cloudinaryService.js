const { v2: cloudinary } = require('cloudinary');

// Configure from env vars set on Render
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Upload a video file buffer to Cloudinary.
 * @param {Buffer} buffer - Video file buffer from multer
 * @param {string} folder - Cloudinary folder (e.g., 'bilimly/tutor-videos')
 * @param {string} publicId - Optional custom public ID
 * @returns {Promise<{ url: string, public_id: string, duration: number }>}
 */
function uploadVideo(buffer, folder = 'bilimly/tutor-videos', publicId = null) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        folder,
        public_id: publicId || undefined,
        chunk_size: 6000000, // 6MB chunks for large files
        eager: [
          { width: 640, height: 360, crop: 'limit', format: 'mp4' }, // web-friendly preview
        ],
        eager_async: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          public_id: result.public_id,
          duration: result.duration,
          format: result.format,
          bytes: result.bytes,
        });
      }
    );
    stream.end(buffer);
  });
}

/**
 * Delete a video from Cloudinary by its public_id.
 * @param {string} publicId
 */
async function deleteVideo(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
  } catch (err) {
    console.error('[CLOUDINARY] Delete error:', err);
  }
}

module.exports = { uploadVideo, deleteVideo, cloudinary };