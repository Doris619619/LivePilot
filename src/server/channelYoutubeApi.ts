/** Binds the generic YouTube adapter to one Connection to prevent cross-channel token use. */
import 'server-only'

import type { LiveServiceApi } from './liveService'
import * as youtube from './youtubeApi'

/** Builds a connection-scoped implementation of the existing lifecycle API. */
export function createChannelYouTubeApi(connectionId: string): LiveServiceApi {
  return {
    getCurrentChannel: () => youtube.getCurrentChannel(undefined, connectionId),
    listLiveBroadcasts: () => youtube.listLiveBroadcasts(connectionId),
    getBroadcastById: (id) => youtube.getBroadcastById(id, connectionId),
    createBroadcast: (input) => youtube.createBroadcast(input, connectionId),
    getOrCreateLiveStream: () => youtube.getOrCreateLiveStream(connectionId),
    getLiveStreamById: (id) => youtube.getLiveStreamById(id, connectionId),
    bindBroadcast: (broadcastId, streamId) => youtube.bindBroadcast(broadcastId, streamId, connectionId),
    getBroadcastContentDetails: (id) => youtube.getBroadcastContentDetails(id, connectionId),
    getBroadcastLifeCycleStatus: (id) => youtube.getBroadcastLifeCycleStatus(id, connectionId),
    getStreamStatus: (id) => youtube.getStreamStatus(id, connectionId),
    transitionBroadcast: (id, target) => youtube.transitionBroadcast(id, target, connectionId),
  }
}
