/**
 * Binds the generic YouTube API adapter to one OAuth connection so lifecycle services
 * cannot accidentally read a different Channel's token or reusable Stream.
 */
import 'server-only'

import type { LiveServiceApi } from './liveService'
import * as youtubeApi from './youtubeApi'

/** Creates an account-scoped implementation of the existing lifecycle adapter contract. */
export function createChannelYouTubeApi(connectionId: string): LiveServiceApi {
  return {
    getCurrentChannel: () => youtubeApi.getCurrentChannel(undefined, connectionId),
    listLiveBroadcasts: () => youtubeApi.listLiveBroadcasts(connectionId),
    getBroadcastById: (broadcastId) => youtubeApi.getBroadcastById(broadcastId, connectionId),
    createBroadcast: (input) => youtubeApi.createBroadcast(input, connectionId),
    getOrCreateLiveStream: () => youtubeApi.getOrCreateLiveStream(connectionId),
    getLiveStreamById: (streamId) => youtubeApi.getLiveStreamById(streamId, connectionId),
    bindBroadcast: (broadcastId, streamId) => youtubeApi.bindBroadcast(broadcastId, streamId, connectionId),
    getBroadcastContentDetails: (broadcastId) => youtubeApi.getBroadcastContentDetails(broadcastId, connectionId),
    getBroadcastLifeCycleStatus: (broadcastId) => youtubeApi.getBroadcastLifeCycleStatus(broadcastId, connectionId),
    getStreamStatus: (streamId) => youtubeApi.getStreamStatus(streamId, connectionId),
    transitionBroadcast: (broadcastId, target) => youtubeApi.transitionBroadcast(broadcastId, target, connectionId),
  }
}
