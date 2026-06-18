const { google } = require('googleapis');

// Initialize Google Calendar client with service account
function getCalendarClient() {
  const credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.replace(/\\n/g, '\n'),
  };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google service account credentials not configured');
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

/**
 * Create a Google Meet link for a lesson
 * @param {object} booking - booking details
 * @param {string} tutorName - tutor full name
 * @param {string} tutorEmail - tutor email
 * @param {string} studentName - student full name  
 * @param {string} studentEmail - student email
 * @param {string} subject - lesson subject
 * @returns {string} Google Meet URL
 */
async function createMeetingLink(booking, tutorName, tutorEmail, studentName, studentEmail, subject) {
  try {
    const calendar = getCalendarClient();

    // Parse lesson date and time
    const lessonDate = new Date(booking.lesson_date);
    const dateStr = lessonDate.toISOString().substring(0, 10);
    const startTime = booking.start_time.substring(0, 5); // HH:MM
    const [startHour, startMin] = startTime.split(':').map(Number);
    
    // Calculate end time (duration in minutes, default 60)
    const durationMins = booking.duration_minutes || 60;
    const startDateTime = new Date(`${dateStr}T${startTime}:00+06:00`); // Bishkek timezone UTC+6
    const endDateTime = new Date(startDateTime.getTime() + durationMins * 60000);

    const event = {
      summary: `Урок: ${subject} — ${tutorName} & ${studentName}`,
      description: `Урок на платформе Bilimpark.kg\n\nРепетитор: ${tutorName}\nСтудент: ${studentName}\nПредмет: ${subject}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'Asia/Bishkek',
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'Asia/Bishkek',
      },
      attendees: [
        { email: tutorEmail, displayName: tutorName },
        { email: studentEmail, displayName: studentName },
      ],
      conferenceData: {
        createRequest: {
          requestId: `bilimpark-${booking.id}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      guestsCanModifyEvent: false,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 10 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all', // sends email invites to attendees
    });

    const meetLink = response.data.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri;

    if (!meetLink) {
      throw new Error('No Meet link generated');
    }

    console.log(`[MEET] Created meeting for booking ${booking.id}: ${meetLink}`);
    return meetLink;

  } catch (err) {
    console.error('[MEET] Error creating meeting:', err.message);
    throw err;
  }
}

/**
 * Delete a Google Meet event (for cancelled lessons)
 */
async function deleteMeetingEvent(eventId) {
  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
    });
    console.log(`[MEET] Deleted event ${eventId}`);
  } catch (err) {
    console.error('[MEET] Error deleting event:', err.message);
  }
}

module.exports = { createMeetingLink, deleteMeetingEvent };
